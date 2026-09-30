'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fail } = require('./errors');
const { isPlainObject, codePointLength } = require('./util');
const time = require('./time');
const { hashPassword, verifyPassword } = require('./password');
const stateLib = require('./state');
const ledger = require('./ledger');
const idempotency = require('./idempotency');
const store = require('./store');
const { requiredString, amountField, noteField, visibilityField, queryParam, intQuery } = require('./validate');
const { SESSION_COOKIE } = require('./http');
const ui = require('./ui');

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

// The browser carries its session in a cookie, the API in a bearer token.
function sessionCookie(token) {
  return SESSION_COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax';
}

function logout(ctx) {
  const token = ctx.session === undefined ? null : ctx.session.token;
  if (token !== null) ctx.state.tokens.delete(token);
  return {
    status: 204,
    headers: { 'Set-Cookie': SESSION_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' },
  };
}

const ASSETS = {};

function asset(name, contentType) {
  if (ASSETS[name] === undefined) ASSETS[name] = fs.readFileSync(path.join(__dirname, name), 'utf8');
  return { status: 200, text: ASSETS[name], contentType, headers: { 'Cache-Control': 'no-store' } };
}

function appScript() {
  return asset('app.js', 'text/javascript; charset=utf-8');
}

function viewsScript() {
  return asset('views.js', 'text/javascript; charset=utf-8');
}

function stylesheet() {
  return asset('styles.css', 'text/css; charset=utf-8');
}

function pageSession(state, ctx) {
  const session = ctx.session === undefined ? { user: null, token: null } : ctx.session;
  if (session.user !== null) stateLib.refreshExpiries(state);
  return {
    user: session.user === null ? null : stateLib.userJson(state, session.user),
    token: session.token,
    currency: state.currency,
    minorUnits: state.minorUnits,
  };
}

function activityFor(state, user, limit) {
  const items = Array.from(state.payments.values()).filter(
    (payment) =>
      payment.visibility === 'public' ||
      payment.from_user_id === user.user_id ||
      payment.to_user_id === user.user_id
  );
  items.sort(stateLib.newestFirst);
  return items.slice(0, limit).map((payment) => stateLib.paymentJson(state, payment));
}

function requestsFor(state, user, limit) {
  const items = Array.from(state.requests.values()).filter(
    (request) => request.requester_id === user.user_id || request.payer_id === user.user_id
  );
  items.sort(stateLib.newestFirst);
  return items.slice(0, limit).map((request) => stateLib.requestJson(state, request));
}

function authorizationsFor(state, user, limit) {
  stateLib.refreshExpiries(state);
  const items = Array.from(state.authorizations.values()).filter(
    (authorization) =>
      authorization.from_user_id === user.user_id || authorization.to_user_id === user.user_id
  );
  items.sort(stateLib.newestFirst);
  return items.slice(0, limit).map((authorization) => stateLib.authorizationJson(state, authorization));
}

function walletPage(ctx) {
  const state = ctx.state;
  const session = pageSession(state, ctx);
  const payments = session.user === null ? [] : activityFor(state, ctx.session.user, 100);
  return { status: 200, html: ui.renderWallet(session, { payments }) };
}

function requestsPage(ctx) {
  const state = ctx.state;
  const session = pageSession(state, ctx);
  const requests = session.user === null ? [] : requestsFor(state, ctx.session.user, 200);
  const payments = session.user === null ? [] : activityFor(state, ctx.session.user, 20);
  return { status: 200, html: ui.renderRequests(session, { requests, payments }) };
}

function splitPage(ctx) {
  const state = ctx.state;
  const session = pageSession(state, ctx);
  const payments = session.user === null ? [] : activityFor(state, ctx.session.user, 20);
  return { status: 200, html: ui.renderSplit(session, { payments }) };
}

function authorizationsPage(ctx) {
  const state = ctx.state;
  const session = pageSession(state, ctx);
  const authorizations = session.user === null ? [] : authorizationsFor(state, ctx.session.user, 200);
  return { status: 200, html: ui.renderAuthorizations(session, { authorizations }) };
}

function loginPage(ctx) {
  return { status: 200, html: ui.renderLogin(pageSession(ctx.state, ctx)) };
}

function signupPage(ctx) {
  return { status: 200, html: ui.renderSignup(pageSession(ctx.state, ctx)) };
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
    opening: 0,
  };
  stateLib.addUser(state, user);
  const token = issueToken(state, user);
  return {
    status: 201,
    body: { user_id: user.user_id, display_name: user.display_name, token },
    headers: { 'Set-Cookie': sessionCookie(token) },
  };
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
  return {
    status: 200,
    body: { user_id: user.user_id, display_name: user.display_name, token },
    headers: { 'Set-Cookie': sessionCookie(token) },
  };
}

// An instant query parameter. Present but not an RFC 3339 instant with an
// offset - including an empty value - is invalid.
function instantParam(url, name) {
  if (!url.searchParams.has(name)) return { present: false, raw: null, ms: null };
  const raw = url.searchParams.get(name);
  const ms = time.parseInstant(raw);
  if (ms === null) fail(422, 'validation_failed', name + ' must be an RFC 3339 instant with an offset');
  return { present: true, raw, ms };
}

function me(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const asOf = instantParam(ctx.url, 'as_of');
  const knownAt = instantParam(ctx.url, 'known_at');
  stateLib.refreshExpiries(state);
  if (!asOf.present && !knownAt.present) {
    return { status: 200, body: stateLib.userJson(state, user) };
  }
  // All four money fields describe the same view: the instant asked about, with
  // the revisions that were known by then.
  const knownMs = knownAt.present ? knownAt.ms : null;
  const atMs = asOf.present ? asOf.ms : Date.now();
  const total = ledger.totalAt(state, user.user_id, atMs, knownMs);
  const held = ledger.heldAt(state, user.user_id, atMs, knownMs);
  const available = total - held;
  const body = {
    user_id: user.user_id,
    display_name: user.display_name,
    handle: user.handle,
    balance: total,
    total,
    available: available < 0 ? 0 : available,
    held,
    currency: state.currency,
    minor_units: state.minorUnits,
  };
  if (asOf.present) body.as_of = asOf.raw;
  if (knownAt.present) body.known_at = knownAt.raw;
  return { status: 200, body };
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
  if (stateLib.availableFor(state, user) < amount) {
    fail(409, 'insufficient_funds', 'The available balance is below the amount');
  }

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
  if (stateLib.availableFor(state, user) < request.amount) {
    fail(409, 'insufficient_funds', 'The available balance is below the amount');
  }

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

function createAuthorization(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const body = ctx.body;
  const amount = amountField(body);
  const note = noteField(body);
  const visibility = visibilityField(body);
  const toHandle = requiredString(body, 'to_handle');
  if (toHandle === user.handle) fail(422, 'self_payment', 'An authorization cannot reserve money for you');
  const toId = state.usersByHandle.get(toHandle);
  if (toId === undefined) fail(404, 'not_found', 'No user has that handle');
  stateLib.refreshExpiries(state);
  if (stateLib.availableFor(state, user) < amount) {
    fail(409, 'insufficient_funds', 'The available balance is below the amount');
  }

  const to = state.users.get(toId);
  const createdMs = Date.now();
  const authorization = {
    authorization_id: stateLib.nextId(state, 'authorization'),
    from_user_id: user.user_id,
    from_handle: user.handle,
    to_user_id: to.user_id,
    to_handle: to.handle,
    amount,
    captured_amount: 0,
    note,
    visibility,
    status: 'open',
    expires_at: time.format(new Date(createdMs + state.authorizationTtlSeconds * 1000)),
    payment_id: null,
    payment_ids: [],
    created_at: time.format(new Date(createdMs)),
    order: (state.seq.order += 1),
  };
  state.authorizations.set(authorization.authorization_id, authorization);
  const response = stateLib.authorizationJson(state, authorization);
  memo.commit(201, response);
  return { status: 201, body: response };
}

function captureAuthorization(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const authorization = state.authorizations.get(ctx.params[0]);
  if (!authorization) fail(404, 'not_found', 'No such authorization');
  if (authorization.to_user_id !== user.user_id) {
    fail(403, 'forbidden', 'Only the receiver may capture this authorization');
  }
  stateLib.refreshExpiries(state);
  if (authorization.status === 'expired') fail(409, 'authorization_expired', 'This authorization has expired');
  if (authorization.status !== 'open') fail(409, 'authorization_not_open', 'This authorization is not open');

  const remaining = stateLib.authorizationRemaining(authorization);
  const body = ctx.body;
  let amount = remaining;
  if (body.amount !== undefined) {
    if (!Number.isInteger(body.amount) || body.amount < 1) {
      fail(422, 'validation_failed', 'amount must be a positive integer number of minor units');
    }
    amount = body.amount;
  }
  if (amount > remaining) {
    fail(422, 'capture_exceeds_authorization', 'The capture is above the uncaptured amount');
  }
  let final = true;
  if (body.final !== undefined) {
    if (typeof body.final !== 'boolean') fail(400, 'malformed_request', 'final must be a boolean');
    final = body.final;
  }

  const eventAt = time.nowMillis();
  const payment = stateLib.applyTransfer(state, state.users.get(authorization.from_user_id), state.users.get(authorization.to_user_id), {
    amount,
    note: authorization.note,
    visibility: authorization.visibility,
    request_id: null,
    settlement_id: null,
    authorization_id: authorization.authorization_id,
    created_at: eventAt,
  });
  authorization.captured_amount += amount;
  authorization.payment_id = payment.payment_id;
  if (authorization.payment_ids === undefined) authorization.payment_ids = [];
  authorization.payment_ids.push(payment.payment_id);
  if (authorization.hold_events === undefined) authorization.hold_events = [];
  // A final capture releases the remainder; so does capturing everything left.
  if (final || authorization.captured_amount >= authorization.amount) {
    authorization.status = 'captured';
    authorization.closed_at = eventAt;
    authorization.hold_events.push({ at: eventAt, amount: 0, release: true });
  } else {
    authorization.hold_events.push({ at: eventAt, amount, release: false });
  }
  const response = stateLib.paymentJson(state, payment);
  memo.commit(201, response);
  return { status: 201, body: response };
}

function voidAuthorization(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const authorization = state.authorizations.get(ctx.params[0]);
  if (!authorization) fail(404, 'not_found', 'No such authorization');
  if (authorization.from_user_id !== user.user_id) {
    fail(403, 'forbidden', 'Only the payer may void this authorization');
  }
  stateLib.refreshExpiries(state);
  if (authorization.status === 'voided') {
    return { status: 200, body: stateLib.authorizationJson(state, authorization) };
  }
  if (authorization.status !== 'open') fail(409, 'authorization_not_open', 'This authorization is not open');
  const eventAt = time.nowMillis();
  authorization.status = 'voided';
  authorization.closed_at = eventAt;
  if (authorization.hold_events === undefined) authorization.hold_events = [];
  authorization.hold_events.push({ at: eventAt, amount: 0, release: true });
  return { status: 200, body: stateLib.authorizationJson(state, authorization) };
}

function listAuthorizations(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const direction = queryParam(ctx.url, 'direction');
  if (direction !== null && direction !== 'incoming' && direction !== 'outgoing') {
    fail(422, 'validation_failed', 'direction must be incoming or outgoing');
  }
  const status = queryParam(ctx.url, 'status');
  if (status !== null && !stateLib.AUTHORIZATION_STATUSES.includes(status)) {
    fail(422, 'validation_failed', 'status must be one of ' + stateLib.AUTHORIZATION_STATUSES.join(', '));
  }
  const limit = intQuery(ctx.url, 'limit', 50, 1, 200);
  const offset = intQuery(ctx.url, 'offset', 0, 0, null);
  stateLib.refreshExpiries(state);

  let items = Array.from(state.authorizations.values()).filter(
    (authorization) =>
      authorization.from_user_id === user.user_id || authorization.to_user_id === user.user_id
  );
  if (direction === 'incoming') items = items.filter((authorization) => authorization.to_user_id === user.user_id);
  if (direction === 'outgoing') items = items.filter((authorization) => authorization.from_user_id === user.user_id);
  if (status !== null) items = items.filter((authorization) => authorization.status === status);
  items.sort(stateLib.newestFirst);
  const page = items.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      authorizations: page.map((authorization) => stateLib.authorizationJson(state, authorization)),
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
    if (stateLib.availableFor(state, state.users.get(userId)) + delta < 0) {
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

// ---- statements ----------------------------------------------------------

function statementPage(ctx, frozen) {
  const limit = intQuery(ctx.url, 'limit', 50, 1, 200);
  const offset = intQuery(ctx.url, 'offset', 0, 0, null);
  const page = frozen.entries.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      opening_balance: frozen.opening_balance,
      entries: page,
      closing_balance: frozen.closing_balance,
      has_more: offset + page.length < frozen.entries.length,
      snapshot: frozen.token,
    },
  };
}

// GET /statement pages one frozen read. The first read takes the window, the
// selected revisions and the balances; later reads only walk that result.
function statement(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  stateLib.refreshExpiries(state);

  const snapshotToken = queryParam(ctx.url, 'snapshot');
  if (snapshotToken !== null) {
    for (const name of ['from', 'to', 'known_at']) {
      if (ctx.url.searchParams.has(name)) {
        fail(422, 'validation_failed', name + ' must not accompany a snapshot');
      }
    }
    const frozen = state.snapshots.get(snapshotToken);
    if (!frozen || frozen.user_id !== user.user_id) fail(404, 'not_found', 'No such statement snapshot');
    return statementPage(ctx, frozen);
  }

  const from = instantParam(ctx.url, 'from');
  const to = instantParam(ctx.url, 'to');
  const knownAt = instantParam(ctx.url, 'known_at');
  const fromMs = from.present ? from.ms : Number.NEGATIVE_INFINITY;
  const toMs = to.present ? to.ms : Date.now() + 1;
  const knownMs = knownAt.present ? knownAt.ms : null;

  const openingBalance = ledger.balanceBefore(state, user.user_id, fromMs, knownMs);
  const closingBalance = ledger.balanceBefore(state, user.user_id, toMs, knownMs);
  const rows = ledger.statementEntries(state, user.user_id, fromMs, toMs, knownMs);

  let running = openingBalance;
  const entries = rows.map((row) => {
    const delta = ledger.signedFor(user.user_id, row.payment, row.revision);
    running += delta;
    const payment = stateLib.paymentJson(state, row.payment);
    payment.amount = row.revision.amount;
    return {
      payment,
      delta,
      balance_after: running,
      revision: row.revision.revision,
      effective_at: row.revision.effective_at,
      recorded_at: row.revision.recorded_at,
    };
  });

  const token = crypto.randomBytes(18).toString('base64url');
  const frozen = {
    token,
    user_id: user.user_id,
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    entries,
  };
  state.snapshots.set(token, frozen);
  const result = statementPage(ctx, frozen);
  if (knownAt.present) result.body.known_at = knownAt.raw;
  return result;
}

// ---- revisions and corrections -------------------------------------------

function listRevisions(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const payment = state.payments.get(ctx.params[0]);
  // A third party cannot even tell whether a payment exists.
  if (!payment) fail(404, 'not_found', 'No such payment');
  if (payment.from_user_id !== user.user_id && payment.to_user_id !== user.user_id) {
    fail(404, 'not_found', 'No such payment');
  }
  return {
    status: 200,
    body: {
      revisions: payment.revisions.map((revision) => ({
        revision: revision.revision,
        amount: revision.amount,
        effective_at: revision.effective_at,
        recorded_at: revision.recorded_at,
        reason: revision.reason,
      })),
    },
  };
}

function correctPayment(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const payment = state.payments.get(ctx.params[0]);
  if (!payment) fail(404, 'not_found', 'No such payment');
  if (payment.from_user_id !== user.user_id) {
    fail(403, 'forbidden', 'Only the original sender may correct this payment');
  }
  // A settlement member and a capture are linked payments: their receipts are
  // immutable however they are revised.
  if (payment.settlement_id !== null && payment.settlement_id !== undefined) {
    fail(422, 'linked_payment_immutable', 'A settlement member cannot be corrected');
  }
  if (payment.authorization_id !== null && payment.authorization_id !== undefined) {
    fail(422, 'linked_payment_immutable', 'A capture cannot be corrected');
  }
  if (payment.refund_of !== null && payment.refund_of !== undefined) {
    fail(422, 'linked_payment_immutable', 'A refund cannot be corrected');
  }

  const body = ctx.body;
  const expectedRevision = body.expected_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    fail(422, 'validation_failed', 'expected_revision must be a positive integer');
  }
  const amount = body.amount;
  if (!Number.isInteger(amount) || amount < 0 || amount > stateLib.MAX_AMOUNT) {
    fail(422, 'validation_failed', 'amount must be an integer between 0 and ' + stateLib.MAX_AMOUNT);
  }
  const reason = body.reason;
  if (typeof reason !== 'string') fail(422, 'validation_failed', 'reason must be a string');
  const reasonLength = codePointLength(reason);
  if (reasonLength < 1 || reasonLength > 200) {
    fail(422, 'validation_failed', 'reason must be 1 to 200 characters');
  }
  if (typeof body.effective_at !== 'string') {
    fail(422, 'validation_failed', 'effective_at must be an RFC 3339 instant with an offset');
  }
  const effectiveMs = time.parseInstant(body.effective_at);
  if (effectiveMs === null) {
    fail(422, 'validation_failed', 'effective_at must be an RFC 3339 instant with an offset');
  }
  if (effectiveMs > Date.now()) fail(422, 'validation_failed', 'effective_at must not be later than now');
  const effectiveAt = body.effective_at;

  const revisions = payment.revisions;
  const current = revisions[revisions.length - 1];
  if (current.revision !== expectedRevision) {
    fail(409, 'stale_revision', 'expected_revision is not the current revision');
  }
  // A correction may not take back money that has already been refunded out.
  if (refundedTotal(state, payment.payment_id) > amount) {
    fail(422, 'refund_exceeds_payment', 'The payment has been refunded more than that');
  }

  // Increasing the amount debits the sender; decreasing it debits the receiver.
  const delta = amount - current.amount;
  if (delta !== 0) {
    const debited = delta > 0 ? state.users.get(payment.from_user_id) : state.users.get(payment.to_user_id);
    if (stateLib.availableFor(state, debited) < Math.abs(delta)) {
      fail(409, 'insufficient_funds', 'The correction is not affordable now');
    }
  }

  // Recorded times for one payment strictly increase, even inside one second.
  let recordedMs = Date.now();
  const lastRecorded = Date.parse(current.recorded_at);
  if (!Number.isNaN(lastRecorded) && recordedMs <= lastRecorded) recordedMs = lastRecorded + 1;
  const revision = {
    revision: current.revision + 1,
    amount,
    effective_at: effectiveAt,
    recorded_at: time.formatMillis(new Date(recordedMs)),
    reason,
  };

  const fromUser = state.users.get(payment.from_user_id);
  const toUser = state.users.get(payment.to_user_id);
  const fromBefore = fromUser.balance;
  const toBefore = toUser.balance;

  // Apply the correction, then put the whole history back if any wallet is
  // overdrawn at any boundary it created.
  revisions.push(revision);
  if (delta !== 0) {
    fromUser.balance -= delta;
    toUser.balance += delta;
  }
  if (!ledger.historyIsNonnegative(state)) {
    revisions.pop();
    fromUser.balance = fromBefore;
    toUser.balance = toBefore;
    fail(409, 'historical_overdraft', 'The correction would overdraw a wallet in the past');
  }

  const response = {
    payment_id: payment.payment_id,
    revision: revision.revision,
    amount: revision.amount,
    effective_at: revision.effective_at,
    recorded_at: revision.recorded_at,
    reason: revision.reason,
  };
  memo.commit(201, response);
  return { status: 201, body: response };
}

// ---- refunds --------------------------------------------------------------

// The amount already refunded against a payment: every refund payment naming it,
// at its latest revision.
function refundedTotal(state, paymentId) {
  let total = 0;
  for (const payment of state.payments.values()) {
    if (payment.refund_of !== paymentId) continue;
    const revision = payment.revisions[payment.revisions.length - 1];
    if (revision) total += revision.amount;
  }
  return total;
}

// A payment's current corrected amount: its latest revision.
function latestAmount(payment) {
  const revision = payment.revisions[payment.revisions.length - 1];
  return revision === undefined ? payment.amount : revision.amount;
}

// An instant a correction may name: an RFC 3339 instant with an offset, not
// later than now. Shared by single corrections and batch items.
function correctionInstant(value, nowMs) {
  if (typeof value !== 'string') {
    fail(422, 'validation_failed', 'effective_at must be an RFC 3339 instant with an offset');
  }
  const ms = time.parseInstant(value);
  if (ms === null) {
    fail(422, 'validation_failed', 'effective_at must be an RFC 3339 instant with an offset');
  }
  if (ms > nowMs) fail(422, 'validation_failed', 'effective_at must not be later than now');
  return ms;
}

// The receiver sends money back. A refund is a new payment in the opposite
// direction that names the payment it reverses.
function refundPayment(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const payment = state.payments.get(ctx.params[0]);
  if (!payment) fail(404, 'not_found', 'No such payment');
  if (payment.to_user_id !== user.user_id) {
    fail(403, 'forbidden', 'Only the original receiver may refund this payment');
  }
  if (payment.refund_of !== null && payment.refund_of !== undefined) {
    fail(422, 'invalid_refund_target', 'A refund cannot itself be refunded');
  }

  const amount = amountField(ctx.body);
  if (refundedTotal(state, payment.payment_id) + amount > latestAmount(payment)) {
    fail(422, 'refund_exceeds_payment', 'Refunds may not exceed the current amount of the payment');
  }
  stateLib.refreshExpiries(state);
  if (stateLib.availableFor(state, user) < amount) {
    fail(409, 'insufficient_funds', 'The available balance is below the refund');
  }

  const refund = stateLib.applyTransfer(state, user, state.users.get(payment.from_user_id), {
    amount,
    note: payment.note,
    visibility: payment.visibility,
    request_id: null,
    settlement_id: null,
    authorization_id: null,
    refund_of: payment.payment_id,
  });
  const response = stateLib.paymentJson(state, refund);
  memo.commit(201, response);
  return { status: 201, body: response };
}

// ---- correction batches ---------------------------------------------------

// Every member of a settlement, from its record when there is one and from the
// payments that name it otherwise.
function settlementMembers(state, settlementId) {
  const settlement = state.settlements.get(settlementId);
  if (settlement) return settlement.payment_ids.slice();
  const members = [];
  for (const payment of state.payments.values()) {
    if (payment.settlement_id === settlementId) members.push(payment.payment_id);
  }
  return members;
}

// One batch item, validated in input order. Returns the prepared correction.
function prepareBatchItem(state, raw, seen, nowMs) {
  if (!isPlainObject(raw)) fail(422, 'validation_failed', 'each correction must be an object');
  const paymentId = raw.payment_id;
  if (typeof paymentId !== 'string' || paymentId.length === 0) {
    fail(422, 'validation_failed', 'each correction needs a payment_id');
  }
  if (seen.has(paymentId)) fail(422, 'validation_failed', 'corrections must name distinct payments');
  seen.add(paymentId);
  const payment = state.payments.get(paymentId);
  if (!payment) fail(404, 'not_found', 'No such payment');
  if (payment.authorization_id !== null && payment.authorization_id !== undefined) {
    fail(422, 'linked_payment_immutable', 'A capture cannot be corrected');
  }
  if (payment.refund_of !== null && payment.refund_of !== undefined) {
    fail(422, 'linked_payment_immutable', 'A refund cannot be corrected');
  }
  const expectedRevision = raw.expected_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    fail(422, 'validation_failed', 'expected_revision must be a positive integer');
  }
  const amount = raw.amount;
  if (!Number.isInteger(amount) || amount < 0 || amount > stateLib.MAX_AMOUNT) {
    fail(422, 'validation_failed', 'amount must be an integer between 0 and ' + stateLib.MAX_AMOUNT);
  }
  const reason = raw.reason;
  if (typeof reason !== 'string') fail(422, 'validation_failed', 'reason must be a string');
  const reasonLength = codePointLength(reason);
  if (reasonLength < 1 || reasonLength > 200) {
    fail(422, 'validation_failed', 'reason must be 1 to 200 characters');
  }
  const effectiveMs = correctionInstant(raw.effective_at, nowMs);
  const current = payment.revisions[payment.revisions.length - 1];
  if (current.revision !== expectedRevision) {
    fail(409, 'stale_revision', 'expected_revision is not the current revision');
  }
  if (refundedTotal(state, payment.payment_id) > amount) {
    fail(422, 'refund_exceeds_payment', 'The payment has been refunded more than that');
  }
  return { payment, amount, effectiveMs, effectiveAt: raw.effective_at, reason };
}

// A settlement operator corrects several payments in one atomic step.
function createCorrectionBatch(ctx) {
  const state = ctx.state;
  const user = ctx.user;
  if (!state.operators.has(user.user_id)) fail(403, 'forbidden', 'This account is not a settlement operator');

  const memo = idempotency.claim(state, user, ctx.method, ctx.path, ctx.idempotencyKey, ctx.body);
  if (memo.replay) return { status: 200, body: memo.body };

  const body = ctx.body;
  const corrections = body.corrections;
  if (corrections === undefined) fail(422, 'validation_failed', 'corrections is required');
  if (!Array.isArray(corrections)) {
    fail(422, 'validation_failed', 'corrections must be an array of 1 to 32 entries');
  }
  if (corrections.length < 1 || corrections.length > 32) {
    fail(422, 'validation_failed', 'corrections must contain 1 to 32 entries');
  }

  const nowMs = Date.now();
  const items = [];
  const seen = new Set();
  for (const raw of corrections) items.push(prepareBatchItem(state, raw, seen, nowMs));

  // A settlement is corrected as a whole: every member, one effective instant.
  const bySettlement = new Map();
  for (const item of items) {
    const settlementId = item.payment.settlement_id;
    if (settlementId === null || settlementId === undefined) continue;
    if (!bySettlement.has(settlementId)) bySettlement.set(settlementId, []);
    bySettlement.get(settlementId).push(item);
  }
  for (const [settlementId, members] of bySettlement) {
    const missing = new Set(settlementMembers(state, settlementId));
    for (const member of members) missing.delete(member.payment.payment_id);
    if (missing.size > 0) {
      fail(422, 'incomplete_settlement', 'Every member of a settlement must be corrected together');
    }
    for (const member of members) {
      if (member.effectiveMs !== members[0].effectiveMs) {
        fail(422, 'validation_failed', 'The members of a settlement must share one effective instant');
      }
    }
  }

  // The combined effect of every proposed revision, against current funds.
  const deltas = new Map();
  for (const item of items) {
    const delta = item.amount - latestAmount(item.payment);
    if (delta === 0) continue;
    const from = item.payment.from_user_id;
    const to = item.payment.to_user_id;
    deltas.set(from, (deltas.get(from) || 0) - delta);
    deltas.set(to, (deltas.get(to) || 0) + delta);
  }
  for (const [userId, delta] of deltas) {
    if (stateLib.availableFor(state, state.users.get(userId)) + delta < 0) {
      fail(409, 'insufficient_funds', 'The correction batch is not affordable');
    }
  }

  // Every new revision shares one recorded time, strictly after each member's
  // previous one.
  let recordedMs = nowMs;
  for (const item of items) {
    const previous = item.payment.revisions[item.payment.revisions.length - 1];
    const previousMs = time.parseInstant(previous.recorded_at);
    if (previousMs !== null && previousMs >= recordedMs) recordedMs = previousMs + 1;
  }
  const recordedAt = time.formatMillis(new Date(recordedMs));
  const batchId = stateLib.nextId(state, 'batch');

  const before = new Map();
  for (const [userId, delta] of deltas) {
    before.set(userId, state.users.get(userId).balance);
    state.users.get(userId).balance += delta;
  }
  const created = [];
  for (const item of items) {
    const previous = item.payment.revisions[item.payment.revisions.length - 1];
    const revision = {
      revision: previous.revision + 1,
      amount: item.amount,
      effective_at: item.effectiveAt,
      recorded_at: recordedAt,
      reason: item.reason,
      correction_batch_id: batchId,
    };
    item.payment.revisions.push(revision);
    created.push(revision);
  }
  if (!ledger.historyIsNonnegative(state)) {
    for (let index = items.length - 1; index >= 0; index -= 1) items[index].payment.revisions.pop();
    for (const [userId, balance] of before) state.users.get(userId).balance = balance;
    fail(409, 'historical_overdraft', 'The correction batch would overdraw a wallet in the past');
  }

  const revisions = items.map((item, index) => ({
    payment_id: item.payment.payment_id,
    revision: created[index].revision,
    amount: created[index].amount,
    effective_at: created[index].effective_at,
    recorded_at: created[index].recorded_at,
    reason: created[index].reason,
    correction_batch_id: batchId,
  }));
  state.correctionBatches.set(batchId, {
    correction_batch_id: batchId,
    operator_id: user.user_id,
    recorded_at: recordedAt,
    revisions,
  });
  const response = { correction_batch_id: batchId, recorded_at: recordedAt, revisions };
  memo.commit(201, response);
  return { status: 201, body: response };
}

module.exports = {
  health,
  logout,
  appScript,
  viewsScript,
  stylesheet,
  walletPage,
  requestsPage,
  splitPage,
  authorizationsPage,
  loginPage,
  signupPage,
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
  createAuthorization,
  captureAuthorization,
  voidAuthorization,
  listAuthorizations,
  createSettlement,
  statement,
  listRevisions,
  correctPayment,
  refundPayment,
  createCorrectionBatch,
};