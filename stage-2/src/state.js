'use strict';

const { fail } = require('./errors');
const { isPlainObject } = require('./util');
const { HANDLE_PATTERN } = require('./validate');
const { hashPassword } = require('./password');
const time = require('./time');

const STATUSES = ['pending', 'paid', 'declined', 'cancelled'];
const VISIBILITIES = ['public', 'private'];
const MINOR_UNITS = [0, 2, 3];
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const ID_PREFIX = { user: 'u', payment: 'p', request: 'rq', split: 'sp', settlement: 'st', authorization: 'a' };
const AUTHORIZATION_STATUSES = ['open', 'captured', 'voided', 'expired'];
const DEFAULT_AUTHORIZATION_TTL_SECONDS = 600;

function createEmptyState() {
  return {
    currency: 'EUR',
    minorUnits: 2,
    users: new Map(),
    usersByHandle: new Map(),
    usersByEmail: new Map(),
    payments: new Map(),
    requests: new Map(),
    splits: new Map(),
    settlements: new Map(),
    authorizations: new Map(),
    authorizationTtlSeconds: DEFAULT_AUTHORIZATION_TTL_SECONDS,
    tokens: new Map(),
    operators: new Set(),
    idempotency: new Map(),
    seq: { user: 0, payment: 0, request: 0, split: 0, settlement: 0, authorization: 0, order: 0 },
  };
}

function nextId(state, kind) {
  state.seq[kind] += 1;
  return ID_PREFIX[kind] + '_' + state.seq[kind];
}

// New ids must not collide with ids that came from a fixture or an import.
function bumpSeq(state, kind, ids) {
  const pattern = new RegExp('^' + ID_PREFIX[kind] + '_(\\d+)$');
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const match = pattern.exec(id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > state.seq[kind]) state.seq[kind] = value;
  }
}

function userJson(state, user) {
  return {
    user_id: user.user_id,
    display_name: user.display_name,
    handle: user.handle,
    balance: user.balance,
    total: user.balance,
    available: availableFor(state, user),
    held: heldFor(state, user.user_id),
    currency: state.currency,
    minor_units: state.minorUnits,
  };
}

// ---- holds and authorisations -----------------------------------------

// The amount still held. A closed authorisation holds nothing, so its
// remaining amount is zero even when part of it was never captured.
function authorizationRemaining(authorization) {
  if (authorization.status !== 'open') return 0;
  const remaining = authorization.amount - authorization.captured_amount;
  return remaining < 0 ? 0 : remaining;
}

function authorizationExpiredAt(authorization, nowMs) {
  const stamp = Date.parse(authorization.expires_at);
  return !Number.isNaN(stamp) && stamp <= nowMs;
}

// An open authorisation whose expires_at has passed holds nothing from that
// moment on, whether or not a request happened to observe the deadline.
function refreshExpiries(state, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  for (const authorization of state.authorizations.values()) {
    if (authorization.status === 'open' && authorizationExpiredAt(authorization, now)) {
      authorization.status = 'expired';
    }
  }
}

function heldFor(state, userId) {
  const now = Date.now();
  let held = 0;
  for (const authorization of state.authorizations.values()) {
    if (authorization.from_user_id !== userId) continue;
    if (authorization.status !== 'open') continue;
    if (authorizationExpiredAt(authorization, now)) continue;
    held += authorizationRemaining(authorization);
  }
  return held;
}

function availableFor(state, user) {
  const available = user.balance - heldFor(state, user.user_id);
  return available < 0 ? 0 : available;
}

function authorizationJson(state, authorization) {
  return {
    authorization_id: authorization.authorization_id,
    from_user_id: authorization.from_user_id,
    from_handle: authorization.from_handle,
    to_user_id: authorization.to_user_id,
    to_handle: authorization.to_handle,
    amount: authorization.amount,
    captured_amount: authorization.captured_amount,
    remaining_amount: authorizationRemaining(authorization),
    currency: state.currency,
    note: authorization.note,
    visibility: authorization.visibility,
    status: authorization.status,
    expires_at: authorization.expires_at,
    payment_id: authorization.payment_id === undefined ? null : authorization.payment_id,
    payment_ids: authorization.payment_ids === undefined ? [] : authorization.payment_ids.slice(),
    created_at: authorization.created_at,
  };
}

function paymentJson(state, payment) {
  return {
    payment_id: payment.payment_id,
    from_user_id: payment.from_user_id,
    from_handle: payment.from_handle,
    to_user_id: payment.to_user_id,
    to_handle: payment.to_handle,
    amount: payment.amount,
    currency: state.currency,
    note: payment.note,
    visibility: payment.visibility,
    request_id: payment.request_id === undefined ? null : payment.request_id,
    settlement_id: payment.settlement_id === undefined ? null : payment.settlement_id,
    authorization_id: payment.authorization_id === undefined ? null : payment.authorization_id,
    created_at: payment.created_at,
  };
}

function requestJson(state, request) {
  return {
    request_id: request.request_id,
    requester_id: request.requester_id,
    requester_handle: request.requester_handle,
    payer_id: request.payer_id,
    payer_handle: request.payer_handle,
    amount: request.amount,
    currency: state.currency,
    note: request.note,
    status: request.status,
    payment_id: request.payment_id === undefined ? null : request.payment_id,
    created_at: request.created_at,
  };
}

function splitJson(state, split) {
  return {
    split_id: split.split_id,
    amount: split.amount,
    currency: state.currency,
    note: split.note,
    shares: split.shares.map((share) => ({ handle: share.handle, amount: share.amount })),
    requests: split.request_ids.map((id) => requestJson(state, state.requests.get(id))),
    created_at: split.created_at,
  };
}

// Equal split in whole minor units; the larger shares go to the first
// participants, and the shares always sum exactly to the amount.
function splitShares(amount, count) {
  const base = Math.floor(amount / count);
  const remainder = amount - base * count;
  const shares = [];
  for (let index = 0; index < count; index += 1) {
    shares.push(base + (index < remainder ? 1 : 0));
  }
  return shares;
}

function newestFirst(left, right) {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return right.order - left.order;
}

function recordPayment(state, from, to, fields) {
  const payment = {
    payment_id: nextId(state, 'payment'),
    from_user_id: from.user_id,
    from_handle: from.handle,
    to_user_id: to.user_id,
    to_handle: to.handle,
    amount: fields.amount,
    note: fields.note,
    visibility: fields.visibility,
    request_id: fields.request_id === undefined ? null : fields.request_id,
    settlement_id: fields.settlement_id === undefined ? null : fields.settlement_id,
    authorization_id: fields.authorization_id === undefined ? null : fields.authorization_id,
    created_at: fields.created_at === undefined ? time.now() : fields.created_at,
    order: (state.seq.order += 1),
  };
  state.payments.set(payment.payment_id, payment);
  return payment;
}
function applyTransfer(state, from, to, fields) {
  const payment = {
    payment_id: nextId(state, 'payment'),
    from_user_id: from.user_id,
    from_handle: from.handle,
    to_user_id: to.user_id,
    to_handle: to.handle,
    amount: fields.amount,
    note: fields.note,
    visibility: fields.visibility,
    request_id: fields.request_id === undefined ? null : fields.request_id,
    settlement_id: fields.settlement_id === undefined ? null : fields.settlement_id,
    authorization_id: fields.authorization_id === undefined ? null : fields.authorization_id,
    created_at: fields.created_at === undefined ? time.now() : fields.created_at,
    order: (state.seq.order += 1),
  };
  from.balance -= fields.amount;
  to.balance += fields.amount;
  state.payments.set(payment.payment_id, payment);
  return payment;
}

function addUser(state, user) {
  state.users.set(user.user_id, user);
  state.usersByHandle.set(user.handle, user.user_id);
  state.usersByEmail.set(user.email.toLowerCase(), user.user_id);
}
function seedFailure(message) {
  fail(422, 'validation_failed', message);
}

function seedString(source, field, label) {
  const value = source[field];
  if (typeof value !== 'string') seedFailure(label + '.' + field + ' must be a string');
  return value;
}

function seedAmount(source, field, label) {
  const value = source[field];
  if (!Number.isInteger(value)) seedFailure(label + '.' + field + ' must be an integer');
  if (value < 1 || value > 1000000000) seedFailure(label + '.' + field + ' is out of range');
  return value;
}

async function stateFromFixture(fixture) {
  if (!isPlainObject(fixture)) fail(400, 'malformed_request', 'Fixture must be a JSON object');
  if (typeof fixture.currency !== 'string' || fixture.currency.length === 0) seedFailure('currency is required');
  if (!MINOR_UNITS.includes(fixture.minor_units)) seedFailure('minor_units must be 0, 2 or 3');
  let ttl = DEFAULT_AUTHORIZATION_TTL_SECONDS;
  if (fixture.authorization_ttl_seconds !== undefined) ttl = fixture.authorization_ttl_seconds;
  if (!Number.isInteger(ttl) || ttl < 1) seedFailure('authorization_ttl_seconds must be a positive integer');

  const rawUsers = fixture.users === undefined ? [] : fixture.users;
  if (!Array.isArray(rawUsers)) seedFailure('users must be an array');
  const drafts = [];
  for (const raw of rawUsers) {
    if (!isPlainObject(raw)) seedFailure('each user must be an object');
    const user_id = seedString(raw, 'id', 'user');
    const email = seedString(raw, 'email', 'user');
    const password = seedString(raw, 'password', 'user');
    const display_name = seedString(raw, 'display_name', 'user');
    const handle = seedString(raw, 'handle', 'user');
    if (!HANDLE_PATTERN.test(handle)) seedFailure('user.handle must match ^[a-z0-9_]{1,20}$');
    const balance = raw.balance;
    if (!Number.isInteger(balance)) seedFailure('user.balance must be an integer');
    if (balance < 0) seedFailure('user.balance must not be negative');
    if (balance > MAX_SAFE) seedFailure('user.balance is out of range');
    drafts.push({ user_id, email, password, display_name, handle, balance });
  }
  const hashes = await Promise.all(drafts.map((draft) => hashPassword(draft.password)));

  const state = createEmptyState();
  state.currency = fixture.currency;
  state.minorUnits = fixture.minor_units;
  state.authorizationTtlSeconds = ttl;
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    if (state.users.has(draft.user_id)) seedFailure('duplicate user id ' + draft.user_id);
    if (state.usersByHandle.has(draft.handle)) seedFailure('duplicate handle ' + draft.handle);
    addUser(state, {
      user_id: draft.user_id,
      email: draft.email,
      password_hash: hashes[index],
      display_name: draft.display_name,
      handle: draft.handle,
      balance: draft.balance,
    });
  }

  const rawPayments = fixture.payments === undefined ? [] : fixture.payments;
  if (!Array.isArray(rawPayments)) seedFailure('payments must be an array');
  for (let index = 0; index < rawPayments.length; index += 1) {
    const raw = rawPayments[index];
    if (!isPlainObject(raw)) seedFailure('each payment must be an object');
    const payment_id = seedString(raw, 'id', 'payment');
    const fromId = seedString(raw, 'from_user_id', 'payment');
    const toId = seedString(raw, 'to_user_id', 'payment');
    const from = state.users.get(fromId);
    const to = state.users.get(toId);
    if (!from || !to) seedFailure('payment ' + payment_id + ' references an unknown user');
    const amount = seedAmount(raw, 'amount', 'payment');
    let note = '';
    if (raw.note !== undefined) note = raw.note;
    if (typeof note !== 'string') seedFailure('payment.note must be a string');
    let visibility = 'public';
    if (raw.visibility !== undefined) visibility = raw.visibility;
    if (!VISIBILITIES.includes(visibility)) seedFailure('payment.visibility must be public or private');
    if (state.payments.has(payment_id)) seedFailure('duplicate payment id ' + payment_id);
    // Seeded balances already include every seeded payment, so the seed is
    // recorded without replaying money.
    state.payments.set(payment_id, {
      payment_id,
      from_user_id: from.user_id,
      from_handle: from.handle,
      to_user_id: to.user_id,
      to_handle: to.handle,
      amount,
      note,
      visibility,
      request_id: raw.request_id === undefined ? null : raw.request_id,
      settlement_id: raw.settlement_id === undefined ? null : raw.settlement_id,
      created_at: time.secondsAgo(index + 1),
      order: (state.seq.order += 1),
    });
  }

  const rawRequests = fixture.requests === undefined ? [] : fixture.requests;
  if (!Array.isArray(rawRequests)) seedFailure('requests must be an array');
  for (let index = 0; index < rawRequests.length; index += 1) {
    const raw = rawRequests[index];
    if (!isPlainObject(raw)) seedFailure('each request must be an object');
    const request_id = seedString(raw, 'id', 'request');
    const requesterId = seedString(raw, 'requester_id', 'request');
    const payerId = seedString(raw, 'payer_id', 'request');
    const requester = state.users.get(requesterId);
    const payer = state.users.get(payerId);
    if (!requester || !payer) seedFailure('request ' + request_id + ' references an unknown user');
    const amount = seedAmount(raw, 'amount', 'request');
    let note = '';
    if (raw.note !== undefined) note = raw.note;
    if (typeof note !== 'string') seedFailure('request.note must be a string');
    let status = 'pending';
    if (raw.status !== undefined) status = raw.status;
    if (!STATUSES.includes(status)) seedFailure('request.status must be one of ' + STATUSES.join(', '));
    if (state.requests.has(request_id)) seedFailure('duplicate request id ' + request_id);
    state.requests.set(request_id, {
      request_id,
      requester_id: requester.user_id,
      requester_handle: requester.handle,
      payer_id: payer.user_id,
      payer_handle: payer.handle,
      amount,
      note,
      status,
      payment_id: raw.payment_id === undefined ? null : raw.payment_id,
      created_at: time.secondsAgo(index + 1),
      order: (state.seq.order += 1),
    });
  }

  const rawOperators = fixture.settlement_operator_ids === undefined ? [] : fixture.settlement_operator_ids;
  if (!Array.isArray(rawOperators)) seedFailure('settlement_operator_ids must be an array');
  for (const operatorId of rawOperators) {
    if (typeof operatorId !== 'string' || !state.users.has(operatorId)) {
      seedFailure('settlement_operator_ids must reference existing users');
    }
    state.operators.add(operatorId);
  }

  const rawAuthorizations = fixture.authorizations === undefined ? [] : fixture.authorizations;
  if (!Array.isArray(rawAuthorizations)) seedFailure('authorizations must be an array');
  for (let index = 0; index < rawAuthorizations.length; index += 1) {
    const raw = rawAuthorizations[index];
    if (!isPlainObject(raw)) seedFailure('each authorization must be an object');
    const authorization_id = seedString(raw, 'id', 'authorization');
    const fromId = seedString(raw, 'from_user_id', 'authorization');
    const toId = seedString(raw, 'to_user_id', 'authorization');
    const from = state.users.get(fromId);
    const to = state.users.get(toId);
    if (!from || !to) seedFailure('authorization ' + authorization_id + ' references an unknown user');
    const amount = seedAmount(raw, 'amount', 'authorization');
    let note = '';
    if (raw.note !== undefined) note = raw.note;
    if (typeof note !== 'string') seedFailure('authorization.note must be a string');
    let visibility = 'public';
    if (raw.visibility !== undefined) visibility = raw.visibility;
    if (!VISIBILITIES.includes(visibility)) seedFailure('authorization.visibility must be public or private');
    let status = 'open';
    if (raw.status !== undefined) status = raw.status;
    if (!AUTHORIZATION_STATUSES.includes(status)) {
      seedFailure('authorization.status must be one of ' + AUTHORIZATION_STATUSES.join(', '));
    }
    const expires_at = seedString(raw, 'expires_at', 'authorization');
    if (Number.isNaN(Date.parse(expires_at))) seedFailure('authorization.expires_at must be an RFC 3339 timestamp');
    let captured_amount = status === 'captured' ? amount : 0;
    if (raw.captured_amount !== undefined) captured_amount = raw.captured_amount;
    if (!Number.isInteger(captured_amount) || captured_amount < 0 || captured_amount > amount) {
      seedFailure('authorization.captured_amount must be an integer between 0 and amount');
    }
    let payment_ids = [];
    if (raw.payment_ids !== undefined) payment_ids = raw.payment_ids;
    if (!Array.isArray(payment_ids) || payment_ids.some((id) => typeof id !== 'string')) {
      seedFailure('authorization.payment_ids must be an array of payment ids');
    }
    if (state.authorizations.has(authorization_id)) seedFailure('duplicate authorization id ' + authorization_id);
    state.authorizations.set(authorization_id, {
      authorization_id,
      from_user_id: from.user_id,
      from_handle: from.handle,
      to_user_id: to.user_id,
      to_handle: to.handle,
      amount,
      captured_amount,
      note,
      visibility,
      status,
      expires_at,
      payment_id: raw.payment_id === undefined ? null : raw.payment_id,
      payment_ids: payment_ids.slice(),
      created_at: raw.created_at === undefined ? time.secondsAgo(index + 1) : seedString(raw, 'created_at', 'authorization'),
      order: (state.seq.order += 1),
    });
  }

  // A user's seeded balance is their total, so open holds must fit inside it.
  for (const user of state.users.values()) {
    if (heldFor(state, user.user_id) > user.balance) {
      seedFailure('open authorizations exceed the balance of ' + user.handle);
    }
  }

  bumpSeq(state, 'user', Array.from(state.users.keys()));
  bumpSeq(state, 'payment', Array.from(state.payments.keys()));
  bumpSeq(state, 'request', Array.from(state.requests.keys()));
  bumpSeq(state, 'authorization', Array.from(state.authorizations.keys()));
  return state;
}
// The export is a detached deep copy, so later writes cannot change it.
function exportDocument(state) {
  const document = {
    track: 'pocketful',
    format_version: 1,
    state: {
      currency: state.currency,
      minor_units: state.minorUnits,
      authorization_ttl_seconds: state.authorizationTtlSeconds,
      seq: Object.assign({}, state.seq),
      users: Array.from(state.users.values()).map((user) => ({
        user_id: user.user_id,
        email: user.email,
        password_hash: user.password_hash,
        display_name: user.display_name,
        handle: user.handle,
        balance: user.balance,
      })),
      tokens: Array.from(state.tokens.entries()),
      payments: Array.from(state.payments.values()),
      requests: Array.from(state.requests.values()),
      authorizations: Array.from(state.authorizations.values()),
      splits: Array.from(state.splits.values()),
      settlements: Array.from(state.settlements.values()),
      operators: Array.from(state.operators),
      idempotency: Array.from(state.idempotency.entries()),
    },
  };
  return JSON.parse(JSON.stringify(document));
}

function importFailure(message) {
  fail(422, 'validation_failed', 'invalid state: ' + message);
}

function importField(source, label, field, rule) {
  const value = source[field];
  if (value === undefined) {
    if (rule.def !== undefined) return rule.def;
    importFailure(label + '.' + field + ' is missing');
  }
  if (rule.type === 'string' && typeof value !== 'string') importFailure(label + '.' + field + ' must be a string');
  if (rule.type === 'integer' && !Number.isInteger(value)) importFailure(label + '.' + field + ' must be an integer');
  if (rule.type === 'nullableString' && value !== null && typeof value !== 'string') {
    importFailure(label + '.' + field + ' must be a string or null');
  }
  if (rule.type === 'enum' && !rule.values.includes(value)) importFailure(label + '.' + field + ' has an unknown value');
  if (rule.min !== undefined && value < rule.min) importFailure(label + '.' + field + ' is out of range');
  if (rule.max !== undefined && value > rule.max) importFailure(label + '.' + field + ' is out of range');
  return value;
}

function importArray(value, label) {
  if (!Array.isArray(value)) importFailure(label + ' must be an array');
  return value;
}

function stateFromImport(document) {
  if (!isPlainObject(document)) importFailure('import body must be a JSON object');
  if (document.track !== 'pocketful') importFailure('unknown track');
  if (document.format_version !== 1) importFailure('unsupported format_version');
  const raw = document.state;
  if (!isPlainObject(raw)) importFailure('state must be an object');
  if (typeof raw.currency !== 'string' || raw.currency.length === 0) importFailure('currency is missing');
  if (!MINOR_UNITS.includes(raw.minor_units)) importFailure('minor_units must be 0, 2 or 3');

  const rawUsers = importArray(raw.users, 'users');
  const rawTokens = importArray(raw.tokens, 'tokens');
  const rawPayments = importArray(raw.payments, 'payments');
  const rawRequests = importArray(raw.requests, 'requests');
  const rawSplits = importArray(raw.splits, 'splits');
  const rawSettlements = importArray(raw.settlements, 'settlements');
  const rawOperators = importArray(raw.operators, 'operators');
  const rawIdempotency = importArray(raw.idempotency, 'idempotency');
  // A stage-1 export carries no authorizations at all; omission means an empty list.
  const rawAuthorizations = raw.authorizations === undefined ? [] : importArray(raw.authorizations, 'authorizations');

  const state = createEmptyState();
  state.currency = raw.currency;
  state.minorUnits = raw.minor_units;
  if (raw.authorization_ttl_seconds !== undefined) {
    if (!Number.isInteger(raw.authorization_ttl_seconds) || raw.authorization_ttl_seconds < 1) {
      importFailure('authorization_ttl_seconds must be a positive integer');
    }
    state.authorizationTtlSeconds = raw.authorization_ttl_seconds;
  }

  for (const entry of rawUsers) {
    if (!isPlainObject(entry)) importFailure('each user must be an object');
    const user = {
      user_id: importField(entry, 'user', 'user_id', { type: 'string' }),
      email: importField(entry, 'user', 'email', { type: 'string' }),
      password_hash: importField(entry, 'user', 'password_hash', { type: 'string' }),
      display_name: importField(entry, 'user', 'display_name', { type: 'string' }),
      handle: importField(entry, 'user', 'handle', { type: 'string' }),
      balance: importField(entry, 'user', 'balance', { type: 'integer', min: 0, max: MAX_SAFE }),
    };
    if (!HANDLE_PATTERN.test(user.handle)) importFailure('user.handle is invalid');
    if (state.users.has(user.user_id)) importFailure('duplicate user id');
    if (state.usersByHandle.has(user.handle)) importFailure('duplicate handle');
    addUser(state, user);
  }

  for (const entry of rawPayments) {
    if (!isPlainObject(entry)) importFailure('each payment must be an object');
    const payment = {
      payment_id: importField(entry, 'payment', 'payment_id', { type: 'string' }),
      from_user_id: importField(entry, 'payment', 'from_user_id', { type: 'string' }),
      from_handle: importField(entry, 'payment', 'from_handle', { type: 'string' }),
      to_user_id: importField(entry, 'payment', 'to_user_id', { type: 'string' }),
      to_handle: importField(entry, 'payment', 'to_handle', { type: 'string' }),
      amount: importField(entry, 'payment', 'amount', { type: 'integer', min: 0, max: 1000000000 }),
      note: importField(entry, 'payment', 'note', { type: 'string', def: '' }),
      visibility: importField(entry, 'payment', 'visibility', { type: 'enum', values: VISIBILITIES, def: 'public' }),
      request_id: importField(entry, 'payment', 'request_id', { type: 'nullableString', def: null }),
      settlement_id: importField(entry, 'payment', 'settlement_id', { type: 'nullableString', def: null }),
      authorization_id: importField(entry, 'payment', 'authorization_id', { type: 'nullableString', def: null }),
      created_at: importField(entry, 'payment', 'created_at', { type: 'string' }),
      order: importField(entry, 'payment', 'order', { type: 'integer', def: 0 }),
    };
    if (!state.users.has(payment.from_user_id) || !state.users.has(payment.to_user_id)) {
      importFailure('payment references an unknown user');
    }
    if (state.payments.has(payment.payment_id)) importFailure('duplicate payment id');
    state.payments.set(payment.payment_id, payment);
  }

  for (const entry of rawRequests) {
    if (!isPlainObject(entry)) importFailure('each request must be an object');
    const request = {
      request_id: importField(entry, 'request', 'request_id', { type: 'string' }),
      requester_id: importField(entry, 'request', 'requester_id', { type: 'string' }),
      requester_handle: importField(entry, 'request', 'requester_handle', { type: 'string' }),
      payer_id: importField(entry, 'request', 'payer_id', { type: 'string' }),
      payer_handle: importField(entry, 'request', 'payer_handle', { type: 'string' }),
      amount: importField(entry, 'request', 'amount', { type: 'integer', min: 0, max: 1000000000 }),
      note: importField(entry, 'request', 'note', { type: 'string', def: '' }),
      status: importField(entry, 'request', 'status', { type: 'enum', values: STATUSES, def: 'pending' }),
      payment_id: importField(entry, 'request', 'payment_id', { type: 'nullableString', def: null }),
      created_at: importField(entry, 'request', 'created_at', { type: 'string' }),
      order: importField(entry, 'request', 'order', { type: 'integer', def: 0 }),
    };
    if (!state.users.has(request.requester_id) || !state.users.has(request.payer_id)) {
      importFailure('request references an unknown user');
    }
    if (state.requests.has(request.request_id)) importFailure('duplicate request id');
    state.requests.set(request.request_id, request);
  }

  for (const entry of rawSplits) {
    if (!isPlainObject(entry)) importFailure('each split must be an object');
    const shares = importArray(entry.shares, 'split.shares').map((share) => {
      if (!isPlainObject(share)) importFailure('each split share must be an object');
      return {
        handle: importField(share, 'share', 'handle', { type: 'string' }),
        amount: importField(share, 'share', 'amount', { type: 'integer', min: 0 }),
      };
    });
    const split = {
      split_id: importField(entry, 'split', 'split_id', { type: 'string' }),
      amount: importField(entry, 'split', 'amount', { type: 'integer', min: 0, max: 1000000000 }),
      note: importField(entry, 'split', 'note', { type: 'string', def: '' }),
      shares,
      request_ids: importArray(entry.request_ids, 'split.request_ids'),
      created_at: importField(entry, 'split', 'created_at', { type: 'string' }),
      order: importField(entry, 'split', 'order', { type: 'integer', def: 0 }),
    };
    for (const id of split.request_ids) {
      if (typeof id !== 'string' || !state.requests.has(id)) importFailure('split references an unknown request');
    }
    if (state.splits.has(split.split_id)) importFailure('duplicate split id');
    state.splits.set(split.split_id, split);
  }

  for (const entry of rawSettlements) {
    if (!isPlainObject(entry)) importFailure('each settlement must be an object');
    const settlement = {
      settlement_id: importField(entry, 'settlement', 'settlement_id', { type: 'string' }),
      operator_id: importField(entry, 'settlement', 'operator_id', { type: 'string' }),
      committed_at: importField(entry, 'settlement', 'committed_at', { type: 'string' }),
      payment_ids: importArray(entry.payment_ids, 'settlement.payment_ids'),
      order: importField(entry, 'settlement', 'order', { type: 'integer', def: 0 }),
    };
    for (const id of settlement.payment_ids) {
      if (typeof id !== 'string' || !state.payments.has(id)) importFailure('settlement references an unknown payment');
    }
    if (state.settlements.has(settlement.settlement_id)) importFailure('duplicate settlement id');
    state.settlements.set(settlement.settlement_id, settlement);
  }

  for (const entry of rawAuthorizations) {
    if (!isPlainObject(entry)) importFailure('each authorization must be an object');
    const authorization = {
      authorization_id: importField(entry, 'authorization', 'authorization_id', { type: 'string' }),
      from_user_id: importField(entry, 'authorization', 'from_user_id', { type: 'string' }),
      from_handle: importField(entry, 'authorization', 'from_handle', { type: 'string' }),
      to_user_id: importField(entry, 'authorization', 'to_user_id', { type: 'string' }),
      to_handle: importField(entry, 'authorization', 'to_handle', { type: 'string' }),
      amount: importField(entry, 'authorization', 'amount', { type: 'integer', min: 1, max: 1000000000 }),
      captured_amount: importField(entry, 'authorization', 'captured_amount', { type: 'integer', def: 0, min: 0, max: 1000000000 }),
      note: importField(entry, 'authorization', 'note', { type: 'string', def: '' }),
      visibility: importField(entry, 'authorization', 'visibility', { type: 'enum', values: VISIBILITIES, def: 'public' }),
      status: importField(entry, 'authorization', 'status', { type: 'enum', values: AUTHORIZATION_STATUSES, def: 'open' }),
      expires_at: importField(entry, 'authorization', 'expires_at', { type: 'string' }),
      payment_id: importField(entry, 'authorization', 'payment_id', { type: 'nullableString', def: null }),
      created_at: importField(entry, 'authorization', 'created_at', { type: 'string', def: '' }),
      order: importField(entry, 'authorization', 'order', { type: 'integer', def: 0 }),
    };
    if (!state.users.has(authorization.from_user_id) || !state.users.has(authorization.to_user_id)) {
      importFailure('an authorization references an unknown user');
    }
    if (authorization.captured_amount > authorization.amount) {
      importFailure('an authorization captured more than it authorised');
    }
    if (Number.isNaN(Date.parse(authorization.expires_at))) importFailure('an authorization expires_at is unreadable');
    const paymentIds = importArray(entry.payment_ids === undefined ? [] : entry.payment_ids, 'authorization.payment_ids');
    for (const id of paymentIds) {
      if (typeof id !== 'string') importFailure('authorization.payment_ids must be payment ids');
    }
    authorization.payment_ids = paymentIds.slice();
    if (authorization.created_at === '') authorization.created_at = time.secondsAgo(state.authorizations.size + 1);
    if (state.authorizations.has(authorization.authorization_id)) importFailure('duplicate authorization id');
    state.authorizations.set(authorization.authorization_id, authorization);
  }

  for (const entry of rawTokens) {
    if (!Array.isArray(entry) || entry.length !== 2) importFailure('each token entry must be a pair');
    const token = entry[0];
    const userId = entry[1];
    if (typeof token !== 'string' || typeof userId !== 'string' || !state.users.has(userId)) {
      importFailure('a session token references an unknown user');
    }
    state.tokens.set(token, userId);
  }

  for (const entry of rawOperators) {
    if (typeof entry !== 'string' || !state.users.has(entry)) importFailure('operator references an unknown user');
    state.operators.add(entry);
  }

  for (const entry of rawIdempotency) {
    if (!Array.isArray(entry) || entry.length !== 2) importFailure('each idempotency entry must be a pair');
    const key = entry[0];
    const value = entry[1];
    if (typeof key !== 'string' || !isPlainObject(value)) importFailure('idempotency entry is malformed');
    if (typeof value.canonical !== 'string' || typeof value.body !== 'string' || !Number.isInteger(value.status)) {
      importFailure('idempotency entry is malformed');
    }
    try {
      JSON.parse(value.body);
    } catch (error) {
      importFailure('idempotency entry holds an unreadable response');
    }
    state.idempotency.set(key, { canonical: value.canonical, status: value.status, body: value.body });
  }

  const seq = isPlainObject(raw.seq) ? raw.seq : {};
  for (const kind of Object.keys(state.seq)) {
    const value = seq[kind];
    state.seq[kind] = Number.isInteger(value) && value >= 0 ? value : 0;
  }
  bumpSeq(state, 'user', Array.from(state.users.keys()));
  bumpSeq(state, 'payment', Array.from(state.payments.keys()));
  bumpSeq(state, 'request', Array.from(state.requests.keys()));
  bumpSeq(state, 'authorization', Array.from(state.authorizations.keys()));
  bumpSeq(state, 'split', Array.from(state.splits.keys()));
  bumpSeq(state, 'settlement', Array.from(state.settlements.keys()));
  let maxOrder = 0;
  for (const collection of [state.payments, state.requests, state.authorizations, state.splits, state.settlements]) {
    for (const item of collection.values()) {
      if (item.order > maxOrder) maxOrder = item.order;
    }
  }
  if (maxOrder > state.seq.order) state.seq.order = maxOrder;
  return state;
}

module.exports = {
  STATUSES,
  VISIBILITIES,
  AUTHORIZATION_STATUSES,
  createEmptyState,
  nextId,
  bumpSeq,
  userJson,
  authorizationJson,
  heldFor,
  availableFor,
  refreshExpiries,
  authorizationRemaining,
  paymentJson,
  requestJson,
  splitJson,
  splitShares,
  newestFirst,
  recordPayment,
  applyTransfer,
  addUser,
  stateFromFixture,
  exportDocument,
  stateFromImport,
};