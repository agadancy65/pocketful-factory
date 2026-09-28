'use strict';

const crypto = require('crypto');
const { fail } = require('./errors');
const { isPlainObject, codePointLength } = require('./util');
const time = require('./time');
const { hashPassword, verifyPassword } = require('./password');
const stateLib = require('./state');
const idempotency = require('./idempotency');
const store = require('./store');
const { requiredString, amountField, noteField, visibilityField, queryParam, intQuery } = require('./validate');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function issueToken(state, user) {
  const token = crypto.randomBytes(24).toString('base64url');
  state.tokens.set(token, user.user_id);
  return token;
}

// The signup handle derived from the email: local part, lowercased, every
// character outside [a-z0-9_] replaced, truncated to 20 characters.
function deriveHandle(email) {
  const local = email.slice(0, email.lastIndexOf('@'));
  const handle = local.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20);
  return handle.length === 0 ? '_' : handle;
}

function createRequestRecord(state, requester, payer, amount, note) {
  const request = {
    request_id: stateLib.nextId(state, 'request'),
    requester_id: requester.user_id,
    requester_handle: requester.handle,
    payer_id: payer.user_id,
    payer_handle: payer.handle,
    amount,
    note,
    status: 'pending',
    payment_id: null,
    created_at: time.now(),
    order: (state.seq.order += 1),
  };
  state.requests.set(request.request_id, request);
  return request;
}

function health() {
  return { status: 200, body: { status: 'ok' } };
}

async function reset(ctx) {
  const next = await stateLib.stateFromFixture(ctx.body);
  store.set(next);
  return { status: 204 };
}

function exportState(ctx) {
  return { status: 200, body: stateLib.exportDocument(ctx.state) };
}

function importState(ctx) {
  const next = stateLib.stateFromImport(ctx.body);
  store.set(next);
  return { status: 204 };
}

async function signup(ctx) {
  const state = ctx.state;
  const body = ctx.body;
  const email = requiredString(body, 'email');
  const password = requiredString(body, 'password');
  const displayName = requiredString(body, 'display_name');
  if (!EMAIL_PATTERN.test(email)) fail(422, 'validation_failed', 'email must be of the form local@domain');
  if (codePointLength(password) < MIN_PASSWORD_LENGTH) {
    fail(422, 'validation_failed', 'password must be at least ' + MIN_PASSWORD_LENGTH + ' characters');
  }
  if (displayName.length === 0) fail(422, 'validation_failed', 'display_name must not be empty');
  if (state.usersByEmail.has(email.toLowerCase())) fail(409, 'email_taken', 'That email is already registered');
  const handle = deriveHandle(email);
  if (state.usersByHandle.has(handle)) fail(409, 'handle_taken', 'The handle derived from that email is taken');

  const passwordHash = await hashPassword(password);

  // Re-check after the await so two concurrent signups cannot both win.
  if (state.usersByEmail.has(email.toLowerCase())) fail(409, 'email_taken', 'That email is already registered');
  if (state.usersByHandle.has(handle)) fail(409, 'handle_taken', 'The handle derived from that email is taken');

  const user = {
    user_id: stateLib.nextId(state, 'user'),
    email,
    password_hash: passwordHash,
    display_name: displayName,
    handle,
    balance: 0,
  };
  stateLib.addUser(state, user);
  const token = issueToken(state, user);
  return { status: 201, body: { user_id: user.user_id, display_name: user.display_name, token } };
}

function login(ctx) {
  const state = ctx.state;
  const body = ctx.body;
  const email = requiredString(body, 'email');
  const password = requiredString(body, 'password');
  const userId = state.usersByEmail.get(email.toLowerCase());
  const user = userId === undefined ? undefined : state.users.get(userId);
  if (!user || !verifyPassword(password, user.password_hash)) {
    fail(401, 'unauthenticated', 'Unknown email or wrong password');
  }
  const token = issueToken(state, user);
  return { status: 200, body: { user_id: user.user_id, display_name: user.display_name, token } };
}

function me(ctx) {
  return { status: 200, body: stateLib.userJson(ctx.state, ctx.user) };
}
function createPayment(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const body = ctx.body;
  const amount = amountField(body);
  const note = noteField(body);
  const visibility = visibilityField(body);
  const toHandle = requiredString(body, 'to_handle');
  if (toHandle === user.handle) fail(422, 'self_payment', 'A payment cannot be sent to your own handle');
  const toId = state.usersByHandle.get(toHandle);
  if (toId === undefined) fail(404, 'not_found', 'No user has that handle');
  const to = state.users.get(toId);
  if (user.balance < amount) fail(409, 'insufficient_funds', 'The wallet balance is below the amount');

  const payment = stateLib.applyTransfer(state, user, to, {
    amount,
    note,
    visibility,
    request_id: null,
    settlement_id: null,
  });
  const response = stateLib.paymentJson(state, payment);
  memo.commit(201, response);
  return { status: 201, body: response };
}

function createRequest(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const body = ctx.body;
  const amount = amountField(body);
  const note = noteField(body);
  const payerHandle = requiredString(body, 'payer_handle');
  if (payerHandle === user.handle) fail(422, 'self_request', 'A request cannot ask you for money');
  const payerId = state.usersByHandle.get(payerHandle);
  if (payerId === undefined) fail(404, 'not_found', 'No user has that handle');
  const payer = state.users.get(payerId);

  // A request may exceed the payer balance: it simply stays pending.
  const request = createRequestRecord(state, user, payer, amount, note);
  const response = stateLib.requestJson(state, request);
  memo.commit(201, response);
  return { status: 201, body: response };
}

function payRequest(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const visibility = visibilityField(ctx.body);
  const request = state.requests.get(ctx.params[0]);
  if (!request) fail(404, 'not_found', 'No such request');
  if (request.payer_id !== user.user_id) fail(403, 'forbidden', 'Only the payer may pay this request');
  if (request.status !== 'pending') fail(409, 'request_not_pending', 'This request is not pending');
  if (user.balance < request.amount) fail(409, 'insufficient_funds', 'The wallet balance is below the amount');

  const requester = state.users.get(request.requester_id);
  const payment = stateLib.applyTransfer(state, user, requester, {
    amount: request.amount,
    note: request.note,
    visibility,
    request_id: request.request_id,
    settlement_id: null,
  });
  request.status = 'paid';
  request.payment_id = payment.payment_id;
  const response = stateLib.paymentJson(state, payment);
  memo.commit(201, response);
  return { status: 201, body: response };
}

function declineRequest(ctx) {
  const state = ctx.state;
  const request = state.requests.get(ctx.params[0]);
  if (!request) fail(404, 'not_found', 'No such request');
  if (request.payer_id !== ctx.user.user_id) fail(403, 'forbidden', 'Only the payer may decline this request');
  if (request.status === 'declined') return { status: 200, body: stateLib.requestJson(state, request) };
  if (request.status !== 'pending') fail(409, 'request_not_pending', 'This request is not pending');
  request.status = 'declined';
  return { status: 200, body: stateLib.requestJson(state, request) };
}

function cancelRequest(ctx) {
  const state = ctx.state;
  const request = state.requests.get(ctx.params[0]);
  if (!request) fail(404, 'not_found', 'No such request');
  if (request.requester_id !== ctx.user.user_id) fail(403, 'forbidden', 'Only the requester may cancel this request');
  if (request.status === 'cancelled') return { status: 200, body: stateLib.requestJson(state, request) };
  if (request.status !== 'pending') fail(409, 'request_not_pending', 'This request is not pending');
  request.status = 'cancelled';
  return { status: 200, body: stateLib.requestJson(state, request) };
}
function listRequests(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const direction = queryParam(ctx.url, 'direction');
  if (direction !== null && direction !== 'incoming' && direction !== 'outgoing') {
    fail(422, 'validation_failed', 'direction must be incoming or outgoing');
  }
  const status = queryParam(ctx.url, 'status');
  if (status !== null && !stateLib.STATUSES.includes(status)) {
    fail(422, 'validation_failed', 'status must be one of ' + stateLib.STATUSES.join(', '));
  }
  const limit = intQuery(ctx.url, 'limit', 50, 1, 200);
  const offset = intQuery(ctx.url, 'offset', 0, 0, null);

  let items = Array.from(state.requests.values()).filter(
    (request) => request.requester_id === user.user_id || request.payer_id === user.user_id
  );
  if (direction === 'incoming') items = items.filter((request) => request.payer_id === user.user_id);
  if (direction === 'outgoing') items = items.filter((request) => request.requester_id === user.user_id);
  if (status !== null) items = items.filter((request) => request.status === status);
  items.sort(stateLib.newestFirst);
  const page = items.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      requests: page.map((request) => stateLib.requestJson(state, request)),
      has_more: offset + page.length < items.length,
    },
  };
}

function createSplit(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const body = ctx.body;
  const amount = amountField(body);
  const note = noteField(body);
  const handles = body.participant_handles;
  if (handles === undefined) fail(422, 'validation_failed', 'participant_handles is required');
  if (!Array.isArray(handles)) fail(400, 'malformed_request', 'participant_handles must be an array');
  if (handles.length === 0) fail(422, 'validation_failed', 'participant_handles must not be empty');
  const seen = new Set();
  for (const handle of handles) {
    if (typeof handle !== 'string') fail(400, 'malformed_request', 'participant_handles must contain handles');
    if (seen.has(handle)) fail(422, 'validation_failed', 'participant_handles contains a duplicate handle');
    seen.add(handle);
  }
  const participants = handles.map((handle) => {
    const userId = state.usersByHandle.get(handle);
    if (userId === undefined) fail(404, 'not_found', 'No user has that handle');
    return state.users.get(userId);
  });

  const shares = stateLib.splitShares(amount, handles.length);
  const shareList = handles.map((handle, index) => ({ handle, amount: shares[index] }));
  const requestIds = [];
  for (let index = 0; index < participants.length; index += 1) {
    if (participants[index].user_id === user.user_id) continue;
    const request = createRequestRecord(state, user, participants[index], shares[index], note);
    requestIds.push(request.request_id);
  }
  const split = {
    split_id: stateLib.nextId(state, 'split'),
    amount,
    note,
    shares: shareList,
    request_ids: requestIds,
    created_at: time.now(),
    order: (state.seq.order += 1),
  };
  state.splits.set(split.split_id, split);
  const response = stateLib.splitJson(state, split);
  memo.commit(201, response);
  return { status: 201, body: response };
}

function listActivity(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const limit = intQuery(ctx.url, 'limit', 50, 1, 200);
  const offset = intQuery(ctx.url, 'offset', 0, 0, null);
  const items = Array.from(state.payments.values()).filter(
    (payment) =>
      payment.visibility === 'public' ||
      payment.from_user_id === user.user_id ||
      payment.to_user_id === user.user_id
  );
  items.sort(stateLib.newestFirst);
  const page = items.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      payments: page.map((payment) => stateLib.paymentJson(state, payment)),
      has_more: offset + page.length < items.length,
    },
  };
}

function createSettlement(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  if (!state.operators.has(user.user_id)) fail(403, 'forbidden', 'This account is not a settlement operator');

  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const body = ctx.body;
  const transfers = body.transfers;
  if (transfers === undefined) fail(422, 'validation_failed', 'transfers is required');
  if (!Array.isArray(transfers)) fail(422, 'validation_failed', 'transfers must be an array of 1 to 32 entries');
  if (transfers.length < 1 || transfers.length > 32) {
    fail(422, 'validation_failed', 'transfers must contain 1 to 32 entries');
  }

  const prepared = [];
  for (const entry of transfers) {
    if (!isPlainObject(entry)) fail(422, 'validation_failed', 'each transfer must be an object');
    const amount = amountField(entry);
    const note = noteField(entry);
    const visibility = visibilityField(entry);
    const fromHandle = entry.from_handle;
    const toHandle = entry.to_handle;
    if (typeof fromHandle !== 'string' || typeof toHandle !== 'string') {
      fail(422, 'validation_failed', 'each transfer needs from_handle and to_handle');
    }
    const fromId = state.usersByHandle.get(fromHandle);
    const toId = state.usersByHandle.get(toHandle);
    if (fromId === undefined || toId === undefined) fail(404, 'not_found', 'No user has that handle');
    if (fromId === toId) fail(422, 'self_payment', 'A transfer cannot move money to the same wallet');
    prepared.push({ from: state.users.get(fromId), to: state.users.get(toId), amount, note, visibility });
  }

  // Affordable when every wallet is nonnegative after all movements together.
  const deltas = new Map();
  for (const item of prepared) {
    deltas.set(item.from.user_id, (deltas.get(item.from.user_id) || 0) - item.amount);
    deltas.set(item.to.user_id, (deltas.get(item.to.user_id) || 0) + item.amount);
  }
  for (const [userId, delta] of deltas) {
    if (state.users.get(userId).balance + delta < 0) {
      fail(409, 'insufficient_funds', 'The settlement is not affordable');
    }
  }

  const committedAt = time.now();
  const settlementId = stateLib.nextId(state, 'settlement');
  for (const [userId, delta] of deltas) {
    state.users.get(userId).balance += delta;
  }
  const paymentIds = [];
  for (const item of prepared) {
    const payment = stateLib.recordPayment(state, item.from, item.to, {
      amount: item.amount,
      note: item.note,
      visibility: item.visibility,
      request_id: null,
      settlement_id: settlementId,
      created_at: committedAt,
    });
    paymentIds.push(payment.payment_id);
  }
  state.settlements.set(settlementId, {
    settlement_id: settlementId,
    operator_id: user.user_id,
    committed_at: committedAt,
    payment_ids: paymentIds,
    order: (state.seq.order += 1),
  });
  const response = {
    settlement_id: settlementId,
    committed_at: committedAt,
    payments: paymentIds.map((id) => stateLib.paymentJson(state, state.payments.get(id))),
  };
  memo.commit(201, response);
  return { status: 201, body: response };
}

module.exports = {
  health,
  reset,
  exportState,
  importState,
  signup,
  login,
  me,
  createPayment,
  createRequest,
  payRequest,
  declineRequest,
  cancelRequest,
  listRequests,
  createSplit,
  listActivity,
  createSettlement,
};