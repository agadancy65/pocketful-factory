'use strict';

// Runs the stage 1 acceptance checks described in the requirements.
//   node tests/checks.js                  -> starts the service in-process on PORT (default 8099)
//   node tests/checks.js http://host:port -> runs against an already running service

const BASE_ARG = process.argv[2];
let BASE = BASE_ARG;
if (!BASE) {
  process.env.PORT = process.env.PORT || '8099';
  require('../src/server.js');
  BASE = 'http://127.0.0.1:' + process.env.PORT;
}

let total = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  total += 1;
  if (!condition) {
    failed += 1;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function expectStatus(name, res, status) {
  check(name, res.status === status, 'expected ' + status + ', got ' + res.status + ' ' + res.text.slice(0, 160));
}

function expectError(name, res, status, code) {
  const ok = res.status === status && res.json && res.json.error && res.json.error.code === code;
  check(name, ok, 'expected ' + status + '/' + code + ', got ' + res.status + ' ' + res.text.slice(0, 160));
}

async function call(method, path, options) {
  const opts = options || {};
  const headers = {};
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
  let payload;
  if (opts.body !== undefined) {
    payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch (error) {
    json = null;
  }
  return { status: res.status, json, text };
}

const post = (path, options) => call('POST', path, options);
const get = (path, options) => call('GET', path, options);

// ---- stage 2 helpers ------------------------------------------------------

const stage2Time = require('../src/time.js');
const stage2Views = require('../src/views.js');

function stamp(offsetSeconds) {
  return stage2Time.format(new Date(Date.now() + offsetSeconds * 1000));
}

async function raw(method, path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  let payload;
  if (opts.body !== undefined) {
    payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, contentType: res.headers.get('content-type') || '' };
}

function hasTestId(html, testid) {
  return html.includes('data-testid="' + testid + '"');
}

function testIdText(html, testid) {
  const needle = 'data-testid="' + testid + '"';
  const at = html.indexOf(needle);
  if (at === -1) return null;
  const open = html.indexOf('>', at);
  if (open === -1) return null;
  const close = html.indexOf('<', open + 1);
  return html.slice(open + 1, close === -1 ? html.length : close);
}

function hold(id, fromId, toId, amount, expiresAt, extra) {
  return Object.assign({
    id,
    from_user_id: fromId,
    to_user_id: toId,
    amount,
    note: '',
    visibility: 'public',
    status: 'open',
    expires_at: expiresAt,
  }, extra || {});
}



async function login(email, password) {
  const res = await post('/auth/login', { body: { email, password } });
  check('login ' + email, res.status === 200, res.status + ' ' + res.text.slice(0, 120));
  return res.json ? res.json.token : null;
}

const PASSWORD = 'correct horse';
const SPEC_FIXTURE = {
  currency: 'EUR',
  minor_units: 2,
  users: [
    { id: 'u_ada', email: 'ada@example.com', password: PASSWORD, display_name: 'Ada', handle: 'ada', balance: 10000 },
    { id: 'u_bob', email: 'bob@example.com', password: PASSWORD, display_name: 'Bob', handle: 'bob', balance: 2500 },
  ],
  payments: [
    { id: 'p_1', from_user_id: 'u_ada', to_user_id: 'u_bob', amount: 500, note: 'coffee', visibility: 'public' },
  ],
  requests: [
    { id: 'rq_1', requester_id: 'u_bob', payer_id: 'u_ada', amount: 1200, note: 'taxi', status: 'pending' },
  ],
};

function fixture(extraUsers, operators) {
  const users = [
    { id: 'u_ada', email: 'ada@example.com', password: PASSWORD, display_name: 'Ada', handle: 'ada', balance: 10000 },
    { id: 'u_bob', email: 'bob@example.com', password: PASSWORD, display_name: 'Bob', handle: 'bob', balance: 2500 },
    { id: 'u_cy', email: 'cy@example.com', password: PASSWORD, display_name: 'Cy', handle: 'cy', balance: 0 },
    { id: 'u_dee', email: 'dee@example.com', password: PASSWORD, display_name: 'Dee', handle: 'dee', balance: 1000 },
  ];
  if (extraUsers) users.push.apply(users, extraUsers);
  return {
    currency: 'EUR',
    minor_units: 2,
    users,
    payments: [],
    requests: [],
    settlement_operator_ids: operators === undefined ? ['u_ada'] : operators,
  };
}

function seededTotal(fixtureObject) {
  return fixtureObject.users.reduce((sum, user) => sum + user.balance, 0);
}

async function balances(tokens) {
  const result = {};
  for (const [handle, token] of Object.entries(tokens)) {
    const res = await get('/me', { token });
    result[handle] = res.json ? res.json.balance : null;
  }
  return result;
}

async function main() {
  // Group 1: health
  const health = await get('/health');
  expectStatus('health returns 200', health, 200);
  check('health body is {"status":"ok"}', health.text === '{"status":"ok"}', health.text);

  // Group 2: reset and login
  let res = await post('/_test/reset', { body: SPEC_FIXTURE });
  expectStatus('reset accepts the spec fixture', res, 204);
  const adaToken = await login('ada@example.com', PASSWORD);
  const bobToken = await login('bob@example.com', PASSWORD);
  res = await get('/me', { token: adaToken });
  check('seeded balance is visible after reset', res.json && res.json.balance === 10000, res.text);
  check('me carries currency and minor units', res.json && res.json.currency === 'EUR' && res.json.minor_units === 2, res.text);
  res = await post('/auth/login', { body: { email: 'ada@example.com', password: 'wrong password' } });
  expectError('login with a wrong password is 401', res, 401, 'unauthenticated');
  res = await post('/_test/reset', { body: JSON.stringify({ currency: 'EUR', minor_units: 2, users: [{ id: 'u_x', email: 'x@example.com', password: PASSWORD, display_name: 'X', handle: 'x', balance: -1 }] }) });
  expectError('negative seeded balance is rejected', res, 422, 'validation_failed');
  res = await get('/me', { token: adaToken });
  check('rejected reset changed nothing', res.json && res.json.balance === 10000, res.text);

  // Group 3: payments
  const base = fixture();
  res = await post('/_test/reset', { body: base });
  expectStatus('reset for payment checks', res, 204);
  const tokens = {
    ada: await login('ada@example.com', PASSWORD),
    bob: await login('bob@example.com', PASSWORD),
    cy: await login('cy@example.com', PASSWORD),
    dee: await login('dee@example.com', PASSWORD),
  };

  const paymentBody = { to_handle: 'bob', amount: 1500, note: 'dinner', visibility: 'public' };
  const first = await post('/payments', { token: tokens.ada, key: 'pay-1', body: paymentBody });
  expectStatus('payment happy path is 201', first, 201);
  check('payment body carries the expected fields', first.json
    && typeof first.json.payment_id === 'string'
    && first.json.from_handle === 'ada'
    && first.json.to_handle === 'bob'
    && first.json.amount === 1500
    && first.json.currency === 'EUR'
    && first.json.note === 'dinner'
    && first.json.visibility === 'public'
    && first.json.request_id === null
    && typeof first.json.created_at === 'string', first.text);
  check('payment created_at is RFC 3339 with an offset', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(first.json.created_at), first.json.created_at);
  let me = await get('/me', { token: tokens.ada });
  check('sender balance moved', me.json.balance === 8500, me.text);
  me = await get('/me', { token: tokens.bob });
  check('receiver balance moved', me.json.balance === 4000, me.text);

  const replay = await post('/payments', { token: tokens.ada, key: 'pay-1', body: paymentBody });
  expectStatus('replay returns 200', replay, 200);
  check('replay body is identical', replay.text === first.text, replay.text);
  const reuse = await post('/payments', { token: tokens.ada, key: 'pay-1', body: { to_handle: 'bob', amount: 1600, note: 'dinner', visibility: 'public' } });
  expectError('same key different body is 409', reuse, 409, 'idempotency_key_reuse');
  const reuseBogus = await post('/payments', { token: tokens.ada, key: 'pay-1', body: { to_handle: 'bob', amount: 0 } });
  expectError('claimed key with an invalid body is still 409', reuseBogus, 409, 'idempotency_key_reuse');
  res = await get('/me', { token: tokens.ada });
  check('replay moved no money', res.json.balance === 8500, res.text);

  const otherPath = await post('/requests', { token: tokens.ada, key: 'pay-1', body: { payer_handle: 'bob', amount: 10 } });
  expectStatus('same key and body on a different path is a new request', otherPath, 201);

  res = await post('/payments', { token: tokens.cy, key: 'pay-poor', body: { to_handle: 'bob', amount: 100 } });
  expectError('insufficient funds is 409', res, 409, 'insufficient_funds');
  me = await get('/me', { token: tokens.cy });
  check('failed payment left no trace for the sender', me.json.balance === 0, me.text);
  me = await get('/me', { token: tokens.bob });
  check('failed payment left no trace for the receiver', me.json.balance === 4000, me.text);

  for (const amount of [0, 1000000001, '100', true]) {
    res = await post('/payments', { token: tokens.ada, key: 'amount-' + String(amount), body: { to_handle: 'bob', amount } });
    expectError('amount ' + JSON.stringify(amount) + ' is 422', res, 422, 'validation_failed');
  }
  res = await post('/payments', { token: tokens.ada, key: 'amount-1e3', body: { to_handle: 'bob', amount: 1e3 } });
  expectStatus('amount 1e3 is accepted', res, 201);
  res = await post('/payments', { token: tokens.ada, key: 'amount-float', body: { to_handle: 'bob', amount: 1000.0 } });
  expectStatus('amount 1000.0 is accepted', res, 201);
  res = await post('/payments', { token: tokens.ada, key: 'amount-1000-5', body: { to_handle: 'bob', amount: 1000.5 } });
  expectError('fractional amount is 422', res, 422, 'validation_failed');

  res = await post('/payments', { token: tokens.ada, key: '', body: { to_handle: 'bob', amount: 10 } });
  expectError('empty idempotency key is 400 missing_idempotency_key', res, 400, 'missing_idempotency_key');
  res = await post('/payments', { token: tokens.ada, body: { to_handle: 'bob', amount: 10 } });
  expectError('absent idempotency key is 400 missing_idempotency_key', res, 400, 'missing_idempotency_key');
  res = await post('/payments', { token: tokens.ada, key: 'k'.repeat(256), body: { to_handle: 'bob', amount: 10 } });
  expectError('256 character idempotency key is 422', res, 422, 'validation_failed');
  res = await post('/payments', { token: tokens.ada, key: 'k'.repeat(255), body: { to_handle: 'bob', amount: 10 } });
  expectStatus('255 character idempotency key is accepted', res, 201);

  res = await post('/payments', { token: tokens.ada, key: 'self-1', body: { to_handle: 'ada', amount: 10 } });
  expectError('self payment is 422 self_payment', res, 422, 'self_payment');
  res = await post('/payments', { token: tokens.ada, key: 'unknown-1', body: { to_handle: 'nobody', amount: 10 } });
  expectError('unknown handle is 404', res, 404, 'not_found');
  res = await post('/payments', { token: tokens.ada, key: 'note-201', body: { to_handle: 'bob', amount: 10, note: 'x'.repeat(201) } });
  expectError('201 character note is 422', res, 422, 'validation_failed');
  res = await post('/payments', { token: tokens.ada, key: 'note-200', body: { to_handle: 'bob', amount: 10, note: 'x'.repeat(200) } });
  expectStatus('200 character note is accepted', res, 201);
  res = await post('/payments', { token: tokens.ada, key: 'note-null', body: { to_handle: 'bob', amount: 10, note: null } });
  expectError('null note is 422', res, 422, 'validation_failed');
  res = await post('/payments', { token: tokens.ada, key: 'vis-bogus', body: { to_handle: 'bob', amount: 10, visibility: 'hidden' } });
  expectError('unknown visibility is 422', res, 422, 'validation_failed');
  res = await post('/payments', { token: tokens.ada, key: 'type-bad', body: '{not json' });
  expectError('unparseable body is 400 malformed_request', res, 400, 'malformed_request');
  res = await post('/payments', { token: tokens.ada, key: 'type-bad2', body: { to_handle: 5, amount: 10 } });
  expectError('wrong JSON type for to_handle is 400', res, 400, 'malformed_request');
  res = await post('/payments', { token: null, key: 'noauth', body: { to_handle: 'bob', amount: 10 } });
  expectError('missing token is 401', res, 401, 'unauthenticated');
  res = await post('/payments', { token: 'nope', key: 'noauth2', body: { to_handle: 'bob', amount: 10 } });
  expectError('unknown token is 401', res, 401, 'unauthenticated');

  const emojiNote = 'caf\u00e9 \u2615\ufe0f \ud83c\udf89 \u00e5\u00e4\u00f6 \u4f60\u597d';
  res = await post('/payments', { token: tokens.ada, key: 'emoji-1', body: { to_handle: 'bob', amount: 10, note: emojiNote } });
  expectStatus('emoji note payment is 201', res, 201);
  check('emoji note survives byte for byte', res.json && res.json.note === emojiNote, JSON.stringify(res.json && res.json.note));
  const emojiListing = await get('/activity?limit=200', { token: tokens.ada });
  const found = emojiListing.json.payments.find((payment) => payment.payment_id === res.json.payment_id);
  check('emoji note survives in the feed', found && found.note === emojiNote, JSON.stringify(found && found.note));

  await groups3456789(tokens, base);
}

async function groups3456789(tokens, base) {
  await group4(tokens);
  await group5(tokens);
  await group6(tokens);
  await group7(tokens, base);
  await group8(tokens, base);
  await group9(tokens);
}
async function loginAll() {
  return {
    ada: await login('ada@example.com', PASSWORD),
    bob: await login('bob@example.com', PASSWORD),
    cy: await login('cy@example.com', PASSWORD),
    dee: await login('dee@example.com', PASSWORD),
  };
}

async function group4(tokens) {
  let res = await post('/requests', { token: tokens.bob, key: 'rq-1', body: { payer_handle: 'cy', amount: 5000, note: 'rent' } });
  expectStatus('request above the payer balance is created', res, 201);
  const requestId = res.json.request_id;
  check('a new request is pending without a payment', res.json.status === 'pending' && res.json.payment_id === null, res.text);

  res = await post('/requests/' + requestId + '/pay', { token: tokens.cy, key: 'rq-pay-1', body: {} });
  expectError('paying while short is 409 insufficient_funds', res, 409, 'insufficient_funds');
  let me = await get('/me', { token: tokens.cy });
  check('a short pay attempt changes nothing', me.json.balance === 0, me.text);

  res = await post('/payments', { token: tokens.ada, key: 'fund-cy', body: { to_handle: 'cy', amount: 6000 } });
  expectStatus('funding the payer works', res, 201);

  const paid = await post('/requests/' + requestId + '/pay', { token: tokens.cy, key: 'rq-pay-2', body: {} });
  expectStatus('paying a funded request is 201', paid, 201);
  check('the payment carries request_id', paid.json.request_id === requestId, paid.text);
  const payReplay = await post('/requests/' + requestId + '/pay', { token: tokens.cy, key: 'rq-pay-2', body: {} });
  expectStatus('replaying a pay is 200', payReplay, 200);
  check('the pay replay body is identical', payReplay.text === paid.text, payReplay.text);
  const otherBody = await post('/requests/' + requestId + '/pay', { token: tokens.cy, key: 'rq-pay-2', body: { visibility: 'public' } });
  expectError('{} and {"visibility":"public"} are different bodies', otherBody, 409, 'idempotency_key_reuse');
  const listing = await get('/requests', { token: tokens.cy });
  const paidRow = listing.json.requests.find((item) => item.request_id === requestId);
  check('the request is paid and carries the payment id', paidRow && paidRow.status === 'paid' && paidRow.payment_id === paid.json.payment_id, JSON.stringify(paidRow));
  const replayAfterPaid = await post('/requests/' + requestId + '/pay', { token: tokens.cy, key: 'rq-pay-2', body: {} });
  expectStatus('replay after the request is paid is still 200', replayAfterPaid, 200);
  check('the late replay body is identical', replayAfterPaid.text === paid.text, replayAfterPaid.text);

  res = await post('/requests', { token: tokens.ada, key: 'rq-decline', body: { payer_handle: 'bob', amount: 100 } });
  const declineId = res.json.request_id;
  const firstDecline = await post('/requests/' + declineId + '/decline', { token: tokens.bob });
  expectStatus('decline is 200', firstDecline, 200);
  check('decline sets the status', firstDecline.json.status === 'declined', firstDecline.text);
  const secondDecline = await post('/requests/' + declineId + '/decline', { token: tokens.bob });
  expectStatus('declining twice is 200', secondDecline, 200);
  check('the second decline keeps the state', secondDecline.json.status === 'declined', secondDecline.text);
  const wrongDecline = await post('/requests/' + declineId + '/decline', { token: tokens.ada });
  expectError('declining as the wrong party is 403', wrongDecline, 403, 'forbidden');
  const cancelDeclined = await post('/requests/' + declineId + '/cancel', { token: tokens.ada });
  expectError('cancelling a declined request is 409', cancelDeclined, 409, 'request_not_pending');

  res = await post('/requests', { token: tokens.ada, key: 'rq-cancel', body: { payer_handle: 'bob', amount: 100 } });
  const cancelId = res.json.request_id;
  const firstCancel = await post('/requests/' + cancelId + '/cancel', { token: tokens.ada });
  expectStatus('cancel is 200', firstCancel, 200);
  check('cancel sets the status', firstCancel.json.status === 'cancelled', firstCancel.text);
  const secondCancel = await post('/requests/' + cancelId + '/cancel', { token: tokens.ada });
  expectStatus('cancelling twice is 200', secondCancel, 200);
  const wrongCancel = await post('/requests/' + cancelId + '/cancel', { token: tokens.bob });
  expectError('cancelling as the wrong party is 403', wrongCancel, 403, 'forbidden');
  const declineCancelled = await post('/requests/' + cancelId + '/decline', { token: tokens.bob });
  expectError('declining a cancelled request is 409', declineCancelled, 409, 'request_not_pending');
  const notPayer = await post('/requests/' + requestId + '/pay', { token: tokens.ada, key: 'rq-notpayer', body: {} });
  expectError('paying as the wrong party is 403', notPayer, 403, 'forbidden');
  const missing = await post('/requests/rq_nope/pay', { token: tokens.ada, key: 'rq-missing', body: {} });
  expectError('an unknown request id is 404', missing, 404, 'not_found');
  const selfRequest = await post('/requests', { token: tokens.ada, key: 'rq-self', body: { payer_handle: 'ada', amount: 10 } });
  expectError('a request to yourself is 422 self_request', selfRequest, 422, 'self_request');

  const all = await get('/requests', { token: tokens.bob });
  check('the caller sees only their own requests', all.json.requests.every((item) => item.requester_id === 'u_bob' || item.payer_id === 'u_bob'), all.text);
  const incoming = await get('/requests?direction=incoming', { token: tokens.bob });
  check('direction=incoming selects requests the caller pays', incoming.json.requests.every((item) => item.payer_id === 'u_bob'), incoming.text);
  const outgoing = await get('/requests?direction=outgoing', { token: tokens.bob });
  check('direction=outgoing selects requests the caller made', outgoing.json.requests.every((item) => item.requester_id === 'u_bob'), outgoing.text);
  const pendingOnly = await get('/requests?status=pending', { token: tokens.bob });
  check('status=pending filters', pendingOnly.json.requests.every((item) => item.status === 'pending'), pendingOnly.text);
  const one = await get('/requests?limit=1', { token: tokens.bob });
  check('limit=1 returns one item and has_more', one.json.requests.length === 1 && one.json.has_more === true, one.text);
  const second = await get('/requests?limit=1&offset=1', { token: tokens.bob });
  check('offset moves the window', second.json.requests.length === 1 && second.json.requests[0].request_id !== one.json.requests[0].request_id, second.text);
  const past = await get('/requests?offset=1000', { token: tokens.bob });
  check('an offset past the end is empty', past.json.requests.length === 0 && past.json.has_more === false, past.text);
  const newestFirst = all.json.requests.every((item, index) => index === 0 || all.json.requests[index - 1].created_at >= item.created_at);
  check('requests are newest first', newestFirst, all.text.slice(0, 200));
  for (const query of ['limit=0', 'limit=201', 'limit=1e9', 'limit=4.0', 'limit=abc', 'offset=-1', 'direction=sideways', 'status=weird']) {
    const bad = await get('/requests?' + query, { token: tokens.bob });
    expectError('GET /requests?' + query + ' is 422', bad, 422, 'validation_failed');
  }
  const ignored = await get('/requests?whatever=1', { token: tokens.bob });
  expectStatus('unknown query parameters are ignored', ignored, 200);
}

async function group5(tokens) {
  await post('/auth/signup', { body: { email: 'eve@example.com', password: PASSWORD, display_name: 'Eve' } });
  const cases = [
    { amount: 1000, handles: ['ada', 'bob', 'cy'], expected: [334, 333, 333] },
    { amount: 1, handles: ['ada', 'bob', 'cy'], expected: [1, 0, 0] },
    { amount: 10, handles: ['ada', 'bob', 'cy'], expected: [4, 3, 3] },
    { amount: 999, handles: ['ada', 'bob', 'cy'], expected: [333, 333, 333] },
    { amount: 5, handles: ['ada', 'bob', 'cy', 'dee', 'eve'], expected: [1, 1, 1, 1, 1] },
    { amount: 1000, handles: ['bob', 'ada', 'cy'], expected: [334, 333, 333] },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const res = await post('/splits', { token: tokens.ada, key: 'split-' + index, body: { amount: item.amount, participant_handles: item.handles, note: 'dinner' } });
    expectStatus('split ' + item.amount + '/' + item.handles.length + ' is 201', res, 201);
    const shares = res.json.shares.map((share) => share.amount);
    check('split ' + item.amount + '/' + item.handles.length + ' shares', JSON.stringify(shares) === JSON.stringify(item.expected), JSON.stringify(shares));
    check('split shares sum to the amount', shares.reduce((a, b) => a + b, 0) === item.amount, JSON.stringify(shares));
    check('split shares keep the input order', JSON.stringify(res.json.shares.map((share) => share.handle)) === JSON.stringify(item.handles), JSON.stringify(res.json.shares.map((share) => share.handle)));
    const others = item.handles.map((handle, position) => ({ handle, amount: item.expected[position] })).filter((entry) => entry.handle !== 'ada');
    check('split requests cover the other participants in order', res.json.requests.length === others.length
      && res.json.requests.every((request, position) => request.payer_handle === others[position].handle && request.amount === others[position].amount), res.text.slice(0, 300));
    check('split requests are pending and requester is the caller', res.json.requests.every((request) => request.status === 'pending' && request.requester_handle === 'ada'), res.text.slice(0, 200));
  }

  let res = await post('/splits', { token: tokens.ada, key: 'split-dup', body: { amount: 100, participant_handles: ['bob', 'bob'] } });
  expectError('a duplicate participant is 422', res, 422, 'validation_failed');
  res = await post('/splits', { token: tokens.ada, key: 'split-empty', body: { amount: 100, participant_handles: [] } });
  expectError('an empty participant list is 422', res, 422, 'validation_failed');
  res = await post('/splits', { token: tokens.ada, key: 'split-unknown', body: { amount: 100, participant_handles: ['nobody'] } });
  expectError('an unknown participant is 404', res, 404, 'not_found');
  res = await post('/splits', { token: tokens.ada, key: 'split-alone', body: { amount: 100, participant_handles: ['ada'] } });
  expectStatus('a caller-only split is 201', res, 201);
  check('a caller-only split creates no requests', Array.isArray(res.json.requests) && res.json.requests.length === 0, res.text);
  check('a caller-only split still computes the share', JSON.stringify(res.json.shares) === JSON.stringify([{ handle: 'ada', amount: 100 }]), res.text);
  res = await post('/splits', { token: tokens.ada, key: 'split-note', body: { amount: 100, participant_handles: ['bob'], note: 'y'.repeat(201) } });
  expectError('a 201 character split note is 422', res, 422, 'validation_failed');
  res = await post('/splits', { token: tokens.ada, key: 'split-type', body: { amount: 100, participant_handles: 'bob' } });
  expectError('a wrongly typed participant_handles is 400', res, 400, 'malformed_request');
  res = await post('/splits', { token: tokens.ada, key: 'split-elem', body: { amount: 100, participant_handles: [123] } });
  expectError('a non-string participant element is 400', res, 400, 'malformed_request');
  res = await post('/splits', { token: tokens.ada, key: 'split-missing', body: { amount: 100 } });
  expectError('a missing participant_handles is 422', res, 422, 'validation_failed');
  res = await post('/splits', { token: tokens.ada, key: 'split-null', body: { amount: 100, participant_handles: null } });
  expectError('a null participant_handles is 400', res, 400, 'malformed_request');
}
async function group6() {
  await post('/_test/reset', { body: fixture() });
  const tokens = await loginAll();
  const priv = await post('/payments', { token: tokens.ada, key: 'feed-priv', body: { to_handle: 'bob', amount: 100, note: 'secret', visibility: 'private' } });
  const pub = await post('/payments', { token: tokens.ada, key: 'feed-pub', body: { to_handle: 'cy', amount: 50, note: 'open', visibility: 'public' } });
  const adaFeed = await get('/activity', { token: tokens.ada });
  const bobFeed = await get('/activity', { token: tokens.bob });
  const deeFeed = await get('/activity', { token: tokens.dee });
  check('the sender sees the private payment', adaFeed.json.payments.some((item) => item.payment_id === priv.json.payment_id), adaFeed.text);
  check('the receiver sees the private payment', bobFeed.json.payments.some((item) => item.payment_id === priv.json.payment_id), bobFeed.text);
  check('a third party does not see the private payment', !deeFeed.json.payments.some((item) => item.payment_id === priv.json.payment_id), deeFeed.text);
  check('everyone sees the public payment', deeFeed.json.payments.some((item) => item.payment_id === pub.json.payment_id), deeFeed.text);
  check('a private payment is not visible to an unrelated payer', !deeFeed.json.payments.some((item) => item.visibility === 'private'), deeFeed.text);

  await post('/requests', { token: tokens.ada, key: 'feed-rq', body: { payer_handle: 'bob', amount: 10 } });
  const afterFeed = await get('/activity?limit=200', { token: tokens.ada });
  check('the feed holds payments only', afterFeed.json.payments.every((item) => typeof item.payment_id === 'string' && item.requester_id === undefined), afterFeed.text.slice(0, 200));
  check('requests never appear in the feed', afterFeed.json.payments.length === 2, String(afterFeed.json.payments.length));
  const privateCount = afterFeed.json.payments.filter((item) => item.visibility === 'private').length;
  check('private payments are flagged as private to participants', privateCount === 1, String(privateCount));
  const paged = await get('/activity?limit=1', { token: tokens.ada });
  check('activity paginates with has_more', paged.json.payments.length === 1 && paged.json.has_more === true, paged.text);
  const bad = await get('/activity?limit=0', { token: tokens.ada });
  expectError('activity limit=0 is 422', bad, 422, 'validation_failed');
}

async function group7() {
  const seed = fixture();
  await post('/_test/reset', { body: seed });
  let tokens = await loginAll();

  const jobs = [];
  for (let index = 0; index < 50; index += 1) {
    const kind = index % 5;
    if (kind === 0) jobs.push(get('/me', { token: tokens.ada }));
    else if (kind === 1) jobs.push(get('/activity', { token: tokens.ada }));
    else if (kind === 2) jobs.push(get('/requests', { token: tokens.ada }));
    else jobs.push(post('/payments', { token: tokens.ada, key: 'conc-' + index, body: { to_handle: 'bob', amount: 1 } }));
  }
  const results = await Promise.all(jobs);
  const serverErrors = results.filter((item) => item.status >= 500).map((item) => item.status);
  check('50 in-flight requests produce no 5xx', serverErrors.length === 0, JSON.stringify(serverErrors));
  const surprises = results.filter((item) => item.status < 200 || item.status >= 300).map((item) => item.status);
  check('50 in-flight requests all succeed', surprises.length === 0, JSON.stringify(surprises));

  const before = await get('/me', { token: tokens.ada });
  const identical = await Promise.all(Array.from({ length: 25 }, () => post('/payments', { token: tokens.ada, key: 'conc-same', body: { to_handle: 'bob', amount: 7, note: 'once' } })));
  const created = identical.filter((item) => item.status === 201);
  const replayed = identical.filter((item) => item.status === 200);
  check('exactly one concurrent identical request is 201', created.length === 1, JSON.stringify(identical.map((item) => item.status)));
  check('the other concurrent identical requests are 200', replayed.length === 24, JSON.stringify(identical.map((item) => item.status)));
  check('all concurrent identical bodies match', identical.every((item) => item.text === created[0].text), 'bodies differ');
  const after = await get('/me', { token: tokens.ada });
  check('concurrent identical requests move money once', before.json.balance - after.json.balance === 7, String(before.json.balance - after.json.balance));

  await post('/_test/reset', { body: seed });
  tokens = await loginAll();
  const created2 = await post('/requests', { token: tokens.bob, key: 'conc-rq', body: { payer_handle: 'ada', amount: 100 } });
  const requestId = created2.json.request_id;
  const pays = await Promise.all(Array.from({ length: 20 }, (unused, index) => post('/requests/' + requestId + '/pay', { token: tokens.ada, key: 'conc-pay-' + index, body: {} })));
  check('a request moves money at most once', pays.filter((item) => item.status === 201).length === 1, JSON.stringify(pays.map((item) => item.status)));
  check('the losing pay attempts are 409', pays.filter((item) => item.status === 409).length === 19, JSON.stringify(pays.map((item) => item.status)));
  const payer = await get('/me', { token: tokens.ada });
  check('the payer moved exactly the requested amount', payer.json.balance === 9900, payer.text);

  const finalBalances = await balances(tokens);
  const sum = Object.values(finalBalances).reduce((a, b) => a + b, 0);
  check('balances still sum to the seeded total', sum === seededTotal(seed), JSON.stringify(finalBalances));
  check('no balance is negative', Object.values(finalBalances).every((value) => value >= 0), JSON.stringify(finalBalances));
}

async function group8() {
  const seed = fixture();
  await post('/_test/reset', { body: seed });
  const tokens = await loginAll();
  const original = await post('/payments', { token: tokens.ada, key: 'exp-1', body: { to_handle: 'bob', amount: 100 } });
  const balancesBefore = await balances(tokens);
  const feedBefore = (await get('/activity?limit=200', { token: tokens.ada })).json;
  const exported = await get('/_test/export');
  expectStatus('export is 200', exported, 200);
  check('export carries track and format_version', exported.json.track === 'pocketful' && exported.json.format_version === 1, exported.text.slice(0, 120));

  await post('/payments', { token: tokens.ada, key: 'exp-2', body: { to_handle: 'cy', amount: 200 } });
  await post('/auth/signup', { body: { email: 'zoe@example.com', password: PASSWORD, display_name: 'Zoe' } });
  const afterWrites = await balances(tokens);
  check('writes after the export are visible before import', afterWrites.ada === balancesBefore.ada - 200, JSON.stringify(afterWrites));

  const imported = await post('/_test/import', { body: JSON.stringify(exported.json) });
  expectStatus('import returns 204', imported, 204);
  const restored = await balances(tokens);
  check('import restores balances without replay', JSON.stringify(restored) === JSON.stringify(balancesBefore), JSON.stringify(restored));
  const zoe = await post('/auth/login', { body: { email: 'zoe@example.com', password: PASSWORD } });
  expectError('import removes data written after the export', zoe, 401, 'unauthenticated');
  const replay = await post('/payments', { token: tokens.ada, key: 'exp-1', body: { to_handle: 'bob', amount: 100 } });
  expectStatus('a stored replay still replays after import', replay, 200);
  check('the imported replay returns the original body', replay.text === original.text, replay.text);
  const feedAfter = (await get('/activity?limit=200', { token: tokens.ada })).json;
  check('import restores identities and timestamps unchanged', JSON.stringify(feedAfter) === JSON.stringify(feedBefore), feedAfter.payments ? String(feedAfter.payments.length) : 'no payments');

  const beforeBad = await balances(tokens);
  let bad = await post('/_test/import', { body: '{not json' });
  expectError('importing broken JSON is 400', bad, 400, 'malformed_request');
  bad = await post('/_test/import', { body: { track: 'other', format_version: 1, state: exported.json.state } });
  expectError('importing an unknown track is 422', bad, 422, 'validation_failed');
  bad = await post('/_test/import', { body: { track: 'pocketful', format_version: 2, state: exported.json.state } });
  expectError('importing an unknown format_version is 422', bad, 422, 'validation_failed');
  bad = await post('/_test/import', { body: { track: 'pocketful', format_version: 1, state: { currency: 'EUR', minor_units: 2, users: [], payments: [{ payment_id: 'p_1', from_user_id: 'u_missing', to_user_id: 'u_missing', from_handle: 'a', to_handle: 'b', amount: 1, created_at: '2026-01-01T00:00:00+00:00' }], requests: [], splits: [], settlements: [], tokens: [], operators: [], idempotency: [] } } });
  expectError('importing an invalid state is 422', bad, 422, 'validation_failed');
  bad = await post('/_test/import', { body: { track: 'pocketful', format_version: 1 } });
  expectError('importing without a state is 422', bad, 422, 'validation_failed');
  const afterBad = await balances(tokens);
  check('failed imports leave the destination unchanged', JSON.stringify(afterBad) === JSON.stringify(beforeBad), JSON.stringify(afterBad));

  const resetAgain = await post('/_test/reset', { body: seed });
  expectStatus('reset clears imported state', resetAgain, 204);
  const staleToken = await get('/me', { token: tokens.ada });
  expectError('reset invalidates imported sessions', staleToken, 401, 'unauthenticated');
  const fresh = await loginAll();
  const reusedKey = await post('/payments', { token: fresh.ada, key: 'exp-1', body: { to_handle: 'bob', amount: 100 } });
  expectStatus('reset clears stored receipts', reusedKey, 201);
  const afterReset = await balances(fresh);
  check('a reset fixture is intact after import activity', afterReset.ada === 9900 && afterReset.bob === 2600, JSON.stringify(afterReset));
}
async function group9() {
  const seed = fixture();
  await post('/_test/reset', { body: seed });
  const tokens = await loginAll();
  const transferBody = { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }, { from_handle: 'bob', to_handle: 'cy', amount: 50 }] };

  const settlement = await post('/settlements', { token: tokens.ada, key: 'st-1', body: transferBody });
  expectStatus('an operator settlement is 201', settlement, 201);
  check('members are returned in the input order', settlement.json.payments.length === 2
    && settlement.json.payments[0].from_handle === 'ada' && settlement.json.payments[0].to_handle === 'bob'
    && settlement.json.payments[1].from_handle === 'bob' && settlement.json.payments[1].to_handle === 'cy', settlement.text);
  check('members share created_at = committed_at', settlement.json.payments.every((item) => item.created_at === settlement.json.committed_at), settlement.text);
  check('members carry the settlement id', settlement.json.payments.every((item) => item.settlement_id === settlement.json.settlement_id), settlement.text);
  check('members have a null request_id', settlement.json.payments.every((item) => item.request_id === null), settlement.text);
  check('committed_at is RFC 3339 with an offset', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(settlement.json.committed_at), settlement.json.committed_at);

  const ada = await get('/me', { token: tokens.ada });
  const bob = await get('/me', { token: tokens.bob });
  const cy = await get('/me', { token: tokens.cy });
  check('settlement balances are net', ada.json.balance === 9900 && bob.json.balance === 2550 && cy.json.balance === 50, [ada.text, bob.text, cy.text].join(' '));

  const ordinary = await post('/payments', { token: tokens.ada, key: 'st-plain', body: { to_handle: 'bob', amount: 10 } });
  check('nonmembers expose a null settlement_id', ordinary.json.settlement_id === null, ordinary.text);
  const feed = await get('/activity?limit=200', { token: tokens.ada });
  check('settlement members keep the settlement id in the feed', feed.json.payments.filter((item) => item.settlement_id === settlement.json.settlement_id).length === 2, feed.text.slice(0, 300));

  const replay = await post('/settlements', { token: tokens.ada, key: 'st-1', body: transferBody });
  expectStatus('a settlement replay is 200', replay, 200);
  check('the settlement replay body is identical', replay.text === settlement.text, replay.text);
  const forbidden = await post('/settlements', { token: tokens.bob, key: 'st-2', body: transferBody });
  expectError('a non-operator settlement is 403', forbidden, 403, 'forbidden');
  const anonymous = await post('/settlements', { key: 'st-3', body: transferBody });
  expectError('a settlement without a token is 401', anonymous, 401, 'unauthenticated');
  const tooMany = await post('/settlements', { token: tokens.ada, key: 'st-4', body: { transfers: Array.from({ length: 33 }, () => ({ from_handle: 'ada', to_handle: 'bob', amount: 1 })) } });
  expectError('33 transfers is 422', tooMany, 422, 'validation_failed');
  const empty = await post('/settlements', { token: tokens.ada, key: 'st-4b', body: { transfers: [] } });
  expectError('an empty transfer list is 422', empty, 422, 'validation_failed');
  const unknownHandle = await post('/settlements', { token: tokens.ada, key: 'st-5', body: { transfers: [{ from_handle: 'ada', to_handle: 'nobody', amount: 1 }] } });
  expectError('an unknown settlement handle is 404', unknownHandle, 404, 'not_found');
  const selfTransfer = await post('/settlements', { token: tokens.ada, key: 'st-6', body: { transfers: [{ from_handle: 'ada', to_handle: 'ada', amount: 1 }] } });
  expectError('a self transfer is 422 self_payment', selfTransfer, 422, 'self_payment');

  const balancesBefore = await balances(tokens);
  const unaffordable = await post('/settlements', { token: tokens.ada, key: 'st-7', body: { transfers: [{ from_handle: 'cy', to_handle: 'ada', amount: 1000000 }] } });
  expectError('an unaffordable settlement is 409', unaffordable, 409, 'insufficient_funds');
  const balancesAfter = await balances(tokens);
  check('a failed settlement changes no state', JSON.stringify(balancesAfter) === JSON.stringify(balancesBefore), JSON.stringify(balancesAfter));
  const retry = await post('/settlements', { token: tokens.ada, key: 'st-7', body: { transfers: [{ from_handle: 'cy', to_handle: 'ada', amount: 10 }] } });
  expectStatus('a failed settlement does not claim its key', retry, 201);

  const netting = await post('/settlements', { token: tokens.ada, key: 'st-net', body: { transfers: [{ from_handle: 'bob', to_handle: 'ada', amount: 500 }, { from_handle: 'ada', to_handle: 'bob', amount: 500 }] } });
  expectStatus('offsetting transfers are affordable together', netting, 201);

  const snapshot = (await get('/_test/export')).json;
  await post('/_test/reset', { body: fixture([], []) });
  const withoutOperators = await loginAll();
  const noPermission = await post('/settlements', { token: withoutOperators.ada, key: 'st-9', body: transferBody });
  expectError('a fixture without operators grants no settlement access', noPermission, 403, 'forbidden');
  const reimported = await post('/_test/import', { body: JSON.stringify(snapshot) });
  expectStatus('import restores the exported state', reimported, 204);
  const restoredOperator = await post('/settlements', { token: tokens.ada, key: 'st-10', body: transferBody });
  expectStatus('import restores operator permissions and sessions', restoredOperator, 201);

  const finalBalances = await balances(tokens);
  const sum = Object.values(finalBalances).reduce((a, b) => a + b, 0);
  check('settlement activity preserves the seeded total', sum === seededTotal(seed), JSON.stringify(finalBalances));
}

async function groups3456789(tokens) {
  await group4(tokens);
  await group5(tokens);
  await group6();
  await group7();
  await group8();
  await group9();
  await group10();
  await group11();
  await group12();
  await group12b();
  await group13();
  await group14();
  await group15();
}

main()
  .then(() => {
    console.log('');
    console.log('checks run: ' + total + ', failures: ' + failed);
    if (failed > 0) {
      console.log('failed checks:');
      for (const item of failures) console.log('  - ' + item);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.log('harness error: ' + (error && error.stack ? error.stack : String(error)));
    process.exit(2);
  });
async function group10() {
  await post('/_test/reset', { body: fixture() });

  let res = await post('/auth/signup', { body: { email: 'new.user+tag@example.com', password: PASSWORD, display_name: 'New User' } });
  expectStatus('signup is 201', res, 201);
  check('signup returns id, display name and token', typeof res.json.user_id === 'string' && res.json.display_name === 'New User' && typeof res.json.token === 'string', res.text);
  const newToken = res.json.token;
  res = await get('/me', { token: newToken });
  check('a new account starts at zero with a derived handle', res.json.balance === 0 && res.json.handle === 'new_user_tag', res.text);
  const newLogin = await post('/auth/login', { body: { email: 'new.user+tag@example.com', password: PASSWORD } });
  expectStatus('a new account can log in', newLogin, 200);
  check('both sessions stay valid', (await get('/me', { token: newToken })).status === 200, 'first token died');

  res = await post('/auth/signup', { body: { email: 'abcdefghijklmnopqrstuvwxy@example.com', password: PASSWORD, display_name: 'Long' } });
  expectStatus('a long local part is accepted', res, 201);
  res = await get('/me', { token: res.json.token });
  check('the derived handle is truncated to 20 characters', res.json.handle === 'abcdefghijklmnopqrst' && res.json.handle.length === 20, res.text);

  res = await post('/auth/signup', { body: { email: 'ada@elsewhere.com', password: PASSWORD, display_name: 'Ada Two' } });
  expectError('a taken derived handle is 409 handle_taken', res, 409, 'handle_taken');
  res = await post('/auth/login', { body: { email: 'ada@elsewhere.com', password: PASSWORD } });
  expectError('a rejected signup creates no account', res, 401, 'unauthenticated');
  res = await post('/auth/signup', { body: { email: 'ADA@example.com', password: PASSWORD, display_name: 'Ada Two' } });
  expectError('a duplicate email is 409 email_taken', res, 409, 'email_taken');
  res = await post('/auth/signup', { body: { email: 'short@example.com', password: '1234567', display_name: 'Short' } });
  expectError('a password shorter than 8 characters is 422', res, 422, 'validation_failed');
  res = await post('/auth/signup', { body: { email: 'not-an-email', password: PASSWORD, display_name: 'Bad' } });
  expectError('an email without a domain is 422', res, 422, 'validation_failed');
  res = await post('/auth/signup', { body: { email: 'nodisplay@example.com', password: PASSWORD } });
  expectError('a missing display_name is 422', res, 422, 'validation_failed');
  res = await get('/me');
  expectError('GET /me without a token is 401', res, 401, 'unauthenticated');

  const tokens = await loginAll();
  res = await post('/payments', { token: tokens.ada, key: 'retry-4xx', body: { to_handle: 'bob', amount: 0 } });
  expectError('an invalid payment is 422', res, 422, 'validation_failed');
  res = await post('/payments', { token: tokens.ada, key: 'retry-4xx', body: { to_handle: 'bob', amount: 10 } });
  expectStatus('a key used by a failed request is a first use again', res, 201);

  const yen = { currency: 'JPY', minor_units: 0, users: [{ id: 'u_y1', email: 'y1@example.com', password: PASSWORD, display_name: 'Y1', handle: 'y1', balance: 1000 }, { id: 'u_y2', email: 'y2@example.com', password: PASSWORD, display_name: 'Y2', handle: 'y2', balance: 0 }], payments: [], requests: [] };
  expectStatus('a JPY fixture is accepted', await post('/_test/reset', { body: yen }), 204);
  const y1 = await login('y1@example.com', PASSWORD);
  res = await get('/me', { token: y1 });
  check('minor_units 0 is reported', res.json.minor_units === 0 && res.json.currency === 'JPY' && res.json.balance === 1000, res.text);
  res = await post('/payments', { token: y1, key: 'yen-1', body: { to_handle: 'y2', amount: 1000 } });
  check('a JPY payment reports the same currency', res.status === 201 && res.json.currency === 'JPY' && res.json.amount === 1000, res.text);

  const dinar = { currency: 'BHD', minor_units: 3, users: [{ id: 'u_d1', email: 'd1@example.com', password: PASSWORD, display_name: 'D1', handle: 'd1', balance: 2500 }, { id: 'u_d2', email: 'd2@example.com', password: PASSWORD, display_name: 'D2', handle: 'd2', balance: 0 }], payments: [], requests: [] };
  expectStatus('a BHD fixture is accepted', await post('/_test/reset', { body: dinar }), 204);
  const d1 = await login('d1@example.com', PASSWORD);
  res = await get('/me', { token: d1 });
  check('minor_units 3 is reported', res.json.minor_units === 3 && res.json.currency === 'BHD', res.text);
  res = await post('/_test/reset', { body: '{"currency":"EUR","minor_units":7,"users":[]}' });
  expectError('an unsupported minor_units value is 422', res, 422, 'validation_failed');
  res = await post('/_test/reset', { body: '{"currency":"EUR","minor_units":2,"users":[{"id":"u_a","email":"a@b.c","password":"x","display_name":"A","handle":"A","balance":0}]}' });
  expectError('an invalid fixture handle is 422', res, 422, 'validation_failed');
}

// Group 11: holds, the derived wallet numbers and reset validation.
async function group11() {
  await post('/_test/reset', { body: fixture() });
  let res = await get('/me', { token: (await loginAll()).ada });
  check('with no holds available, total and balance agree and held is zero',
    res.json.balance === res.json.total && res.json.total === res.json.available && res.json.held === 0, res.text);

  const heldFixture = fixture();
  heldFixture.authorizations = [hold('a_seed_open', 'u_ada', 'u_bob', 2000, stamp(7200), { note: 'deposit' })];
  expectStatus('a fixture with a seeded open hold is accepted', await post('/_test/reset', { body: heldFixture }), 204);
  const tokens = await loginAll();

  res = await get('/me', { token: tokens.ada });
  check('a seeded hold leaves total and balance unchanged', res.json.balance === 10000 && res.json.total === 10000, res.text);
  check('a seeded hold is held and removed from available', res.json.held === 2000 && res.json.available === 8000, res.text);
  res = await get('/me', { token: tokens.bob });
  check('a hold does not credit the receiver', res.json.held === 0 && res.json.available === 2500 && res.json.total === 2500, res.text);
  res = await get('/authorizations', { token: tokens.ada });
  check('GET /authorizations lists the seeded hold', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id === 'a_seed_open', res.text);
  check('a seeded hold reports its remaining amount', res.json.authorizations[0].remaining_amount === 2000 && res.json.authorizations[0].captured_amount === 0, res.text);
  res = await get('/activity?limit=200', { token: tokens.ada });
  check('an open hold is never an activity item', res.json.payments.length === 0, res.text);

  res = await post('/payments', { token: tokens.ada, key: 'hold-over', body: { to_handle: 'bob', amount: 8001 } });
  expectError('a payment above available is 409 insufficient_funds', res, 409, 'insufficient_funds');
  res = await post('/payments', { token: tokens.ada, key: 'hold-ok', body: { to_handle: 'bob', amount: 8000 } });
  expectStatus('a payment up to available is accepted', res, 201);
  res = await get('/me', { token: tokens.ada });
  check('the payment spends available and leaves the hold alone', res.json.total === 2000 && res.json.held === 2000 && res.json.available === 0, res.text);

  const overflow = fixture();
  overflow.authorizations = [hold('a_over', 'u_ada', 'u_bob', 10001, stamp(7200))];
  res = await post('/_test/reset', { body: overflow });
  expectError('open holds above the balance are 422 validation_failed', res, 422, 'validation_failed');
  res = await get('/me', { token: tokens.ada });
  check('a rejected reset changes nothing', res.json.total === 2000 && res.json.held === 2000 && res.json.available === 0, res.text);

  const badTtl = fixture();
  badTtl.authorization_ttl_seconds = 0;
  expectError('a non-positive authorization ttl is 422', await post('/_test/reset', { body: badTtl }), 422, 'validation_failed');
  const fractionalTtl = fixture();
  fractionalTtl.authorization_ttl_seconds = 1.5;
  expectError('a fractional authorization ttl is 422', await post('/_test/reset', { body: fractionalTtl }), 422, 'validation_failed');
  const goodTtl = fixture();
  goodTtl.authorization_ttl_seconds = 60;
  expectStatus('a positive authorization ttl is accepted', await post('/_test/reset', { body: goodTtl }), 204);
}
// Group 12: authorisations, captures, voids, listing and filters.
async function group12() {
  await post('/_test/reset', { body: fixture() });
  const t = await loginAll();

  let res = await post('/authorizations', { token: t.ada, key: 'au-1', body: { to_handle: 'bob', amount: 2000, note: 'deposit', visibility: 'private' } });
  expectStatus('a new authorization is 201', res, 201);
  const a1 = res.json.authorization_id;
  check('a new authorization is open with nothing captured', res.json.status === 'open' && res.json.captured_amount === 0 && res.json.remaining_amount === 2000, res.text);
  check('the authorization names both parties and the currency', res.json.from_handle === 'ada' && res.json.to_handle === 'bob' && res.json.from_user_id === 'u_ada' && res.json.currency === 'EUR', res.text);
  check('the note and visibility are kept', res.json.note === 'deposit' && res.json.visibility === 'private', res.text);
  check('expires_at is created_at plus the service ttl', Date.parse(res.json.expires_at) - Date.parse(res.json.created_at) === 600000, res.text);
  check('a new authorization has no payment yet', res.json.payment_id === null && res.json.payment_ids.length === 0, res.text);

  res = await get('/me', { token: t.ada });
  check('an authorization holds money without moving it', res.json.balance === 10000 && res.json.total === 10000 && res.json.held === 2000 && res.json.available === 8000, res.text);
  res = await get('/me', { token: t.bob });
  check('the receiver is unaffected while the hold is open', res.json.held === 0 && res.json.available === 2500, res.text);
  res = await get('/activity?limit=200', { token: t.ada });
  check('an open authorization is not an activity item', res.json.payments.length === 0, res.text);

  res = await post('/authorizations', { token: t.ada, key: 'au-1', body: { to_handle: 'bob', amount: 2000, note: 'deposit', visibility: 'private' } });
  check('replaying an authorization returns the same record', res.status === 200 && res.json.authorization_id === a1, res.text);
  res = await get('/me', { token: t.ada });
  check('a replay holds the money once', res.json.held === 2000 && res.json.available === 8000, res.text);
  res = await post('/authorizations', { token: t.ada, key: 'au-1', body: { to_handle: 'bob', amount: 3000, note: 'deposit', visibility: 'private' } });
  expectError('reusing a key with a new body is 409 idempotency_key_reuse', res, 409, 'idempotency_key_reuse');
  res = await post('/authorizations', { token: t.ada, body: { to_handle: 'bob', amount: 100 } });
  expectError('a missing Idempotency-Key is 400 missing_idempotency_key', res, 400, 'missing_idempotency_key');

  res = await post('/authorizations', { token: t.ada, key: 'au-big', body: { to_handle: 'bob', amount: 8001 } });
  expectError('an authorization above available is 409 insufficient_funds', res, 409, 'insufficient_funds');
  res = await post('/authorizations', { token: t.ada, key: 'au-zero', body: { to_handle: 'bob', amount: 0 } });
  expectError('an amount below 1 is 422', res, 422, 'validation_failed');
  res = await post('/authorizations', { token: t.ada, key: 'au-huge', body: { to_handle: 'bob', amount: 1000000001 } });
  expectError('an amount above the cap is 422', res, 422, 'validation_failed');
  res = await post('/authorizations', { token: t.ada, key: 'au-frac', body: { to_handle: 'bob', amount: 10.5 } });
  expectError('a non-integer amount is 422', res, 422, 'validation_failed');
  res = await post('/authorizations', { token: t.ada, key: 'au-self', body: { to_handle: 'ada', amount: 100 } });
  expectError('authorising yourself is 422 self_payment', res, 422, 'self_payment');
  res = await post('/authorizations', { token: t.ada, key: 'au-unknown', body: { to_handle: 'nobody', amount: 100 } });
  expectError('an unknown handle is 404', res, 404, 'not_found');
  res = await post('/authorizations', { token: t.ada, key: 'au-note', body: { to_handle: 'bob', amount: 100, note: 'x'.repeat(201) } });
  expectError('a 201 character note is 422', res, 422, 'validation_failed');
  res = await post('/authorizations', { token: t.ada, key: 'au-vis', body: { to_handle: 'bob', amount: 100, visibility: 'hidden' } });
  expectError('an unknown visibility is 422', res, 422, 'validation_failed');
  res = await post('/authorizations', { token: t.ada, key: 'au-type', body: { to_handle: 5, amount: 100 } });
  expectError('a wrong JSON type for to_handle is 400 malformed_request', res, 400, 'malformed_request');
  res = await post('/authorizations', { token: null, key: 'au-noauth', body: { to_handle: 'bob', amount: 100 } });
  expectError('an unauthenticated authorization is 401', res, 401, 'unauthenticated');

  res = await post('/authorizations/' + a1 + '/capture', { token: t.ada, key: 'cap-owner', body: { amount: 500 } });
  expectError('the payer cannot capture their own authorization', res, 403, 'forbidden');
  res = await post('/authorizations/' + a1 + '/capture', { token: t.cy, key: 'cap-stranger', body: { amount: 500 } });
  expectError('a third party cannot capture', res, 403, 'forbidden');
  res = await post('/authorizations/a_missing/capture', { token: t.bob, key: 'cap-missing', body: { amount: 500 } });
  expectError('an unknown authorization is 404', res, 404, 'not_found');
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-over', body: { amount: 2001 } });
  expectError('capturing above the remainder is 422 capture_exceeds_authorization', res, 422, 'capture_exceeds_authorization');
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-zero', body: { amount: 0 } });
  expectError('a capture amount below 1 is 422', res, 422, 'validation_failed');
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-frac', body: { amount: 1.5 } });
  expectError('a fractional capture amount is 422', res, 422, 'validation_failed');
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-final-type', body: { amount: 100, final: 'no' } });
  expectError('a non-boolean final is 400 malformed_request', res, 400, 'malformed_request');

  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-1', body: { amount: 1500 } });
  expectStatus('a capture is 201', res, 201);
  const cap1 = res.json.payment_id;
  check('a capture returns the payment shape', res.json.from_handle === 'ada' && res.json.to_handle === 'bob' && res.json.amount === 1500, res.text);
  check('a capture payment carries the authorization and no request', res.json.authorization_id === a1 && res.json.request_id === null, res.text);
  check('a capture copies the note and visibility', res.json.note === 'deposit' && res.json.visibility === 'private', res.text);
  const adaAfter = await get('/me', { token: t.ada });
  const bobAfter = await get('/me', { token: t.bob });
  check('a final capture moves the money and releases the remainder', adaAfter.json.total === 8500 && adaAfter.json.held === 0 && adaAfter.json.available === 8500, adaAfter.text);
  check('a capture credits the receiver', bobAfter.json.total === 4000 && bobAfter.json.available === 4000, bobAfter.text);
  res = await get('/authorizations?status=captured', { token: t.ada });
  check('a final capture closes the authorization', res.json.authorizations.length === 1 && res.json.authorizations[0].status === 'captured' && res.json.authorizations[0].captured_amount === 1500 && res.json.authorizations[0].remaining_amount === 0, res.text);
  check('the closed authorization names its payment', res.json.authorizations[0].payment_id === cap1 && res.json.authorizations[0].payment_ids.length === 1, res.text);
  res = await get('/activity?limit=200', { token: t.bob });
  check('a captured payment joins the activity feed', res.json.payments.some((payment) => payment.payment_id === cap1 && payment.authorization_id === a1), res.text);
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-1', body: { amount: 1500 } });
  check('replaying a capture returns the original body', res.status === 200 && res.text === JSON.stringify(res.json) && res.json.payment_id === cap1, res.text);
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-1', body: {} });
  expectError('{} and {"amount":1500} are different capture bodies', res, 409, 'idempotency_key_reuse');
  res = await post('/authorizations/' + a1 + '/capture', { token: t.bob, key: 'cap-again', body: { amount: 100 } });
  expectError('capturing a closed authorization is 409 authorization_not_open', res, 409, 'authorization_not_open');
}
// Group 12b: extended capture mode, voids, listing and filters.
async function group12b() {
  await post('/_test/reset', { body: fixture() });
  const t = await loginAll();

  let res = await post('/authorizations', { token: t.ada, key: 'au-2', body: { to_handle: 'bob', amount: 2000, note: 'hold', visibility: 'public' } });
  expectStatus('a second authorization is created', res, 201);
  const a2 = res.json.authorization_id;
  res = await get('/me', { token: t.ada });
  check('the open hold lowers available', res.json.total === 10000 && res.json.held === 2000 && res.json.available === 8000, res.text);

  res = await post('/authorizations/' + a2 + '/capture', { token: t.bob, key: 'cap-part-1', body: { amount: 700, final: false } });
  expectStatus('a nonfinal capture is 201', res, 201);
  res = await get('/authorizations?status=open', { token: t.ada });
  check('a nonfinal capture keeps the remainder held', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id === a2 && res.json.authorizations[0].captured_amount === 700 && res.json.authorizations[0].remaining_amount === 1300, res.text);
  res = await get('/me', { token: t.ada });
  check('a partial capture spends part of the hold and keeps the rest', res.json.total === 9300 && res.json.held === 1300 && res.json.available === 8000, res.text);

  res = await post('/authorizations/' + a2 + '/capture', { token: t.bob, key: 'cap-part-2', body: { amount: 1301 } });
  expectError('capturing above the remaining amount is 422', res, 422, 'capture_exceeds_authorization');
  res = await post('/authorizations/' + a2 + '/capture', { token: t.bob, key: 'cap-part-2', body: { amount: 1300 } });
  expectStatus('capturing the whole remainder closes it even with final false outstanding', res, 201);
  res = await get('/authorizations?status=captured', { token: t.bob });
  check('a fully captured authorization records every capture', res.json.authorizations.length === 1 && res.json.authorizations[0].captured_amount === 2000 && res.json.authorizations[0].remaining_amount === 0 && res.json.authorizations[0].payment_ids.length === 2, res.text);
  check('the last capture is the reported payment', res.json.authorizations[0].payment_id === res.json.authorizations[0].payment_ids[1], res.text);

  res = await post('/authorizations', { token: t.ada, key: 'au-3', body: { to_handle: 'cy', amount: 400, note: 'gift', visibility: 'public' } });
  const a3 = res.json.authorization_id;
  res = await post('/authorizations/' + a3 + '/void', { token: t.cy, body: {} });
  expectError('the receiver cannot void the hold', res, 403, 'forbidden');
  res = await post('/authorizations/' + a3 + '/void', { token: t.dee, body: {} });
  expectError('a third party cannot void', res, 403, 'forbidden');
  res = await post('/authorizations/a_missing/void', { token: t.ada, body: {} });
  expectError('voiding an unknown authorization is 404', res, 404, 'not_found');
  const beforeVoid = await get('/me', { token: t.ada });
  res = await post('/authorizations/' + a3 + '/void', { token: t.ada, body: {} });
  expectStatus('the payer can void the hold', res, 200);
  check('a void reports the released hold', res.json.status === 'voided' && res.json.remaining_amount === 0, res.text);
  const afterVoid = await get('/me', { token: t.ada });
  check('a void returns the money to available', afterVoid.json.held === beforeVoid.json.held - 400 && afterVoid.json.available === beforeVoid.json.available + 400, beforeVoid.text + ' -> ' + afterVoid.text);
  res = await post('/authorizations/' + a3 + '/void', { token: t.ada, body: {} });
  check('voiding twice is still 200 with the same state', res.status === 200 && res.json.status === 'voided', res.text);
  res = await post('/authorizations/' + a2 + '/void', { token: t.ada, body: {} });
  expectError('voiding a captured authorization is 409 authorization_not_open', res, 409, 'authorization_not_open');

  res = await get('/authorizations', { token: t.ada });
  check('a caller only sees their own authorizations', res.json.authorizations.length === 2 && res.json.authorizations.every((item) => item.from_handle === 'ada' || item.to_handle === 'ada'), res.text);
  res = await get('/authorizations', { token: t.bob });
  check('the receiver sees only the authorizations addressed to them', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id === a2, res.text);
  res = await get('/authorizations', { token: t.cy });
  check('the receiver sees the payee side of the void', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id === a3, res.text);
  res = await get('/authorizations?direction=outgoing', { token: t.ada });
  check('direction=outgoing keeps the caller as payer', res.json.authorizations.length === 2 && res.json.authorizations.every((item) => item.from_handle === 'ada'), res.text);
  res = await get('/authorizations?direction=incoming', { token: t.ada });
  check('direction=incoming is empty for a pure payer', res.json.authorizations.length === 0, res.text);
  res = await get('/authorizations?limit=1', { token: t.ada });
  check('limit returns one item and reports more', res.json.authorizations.length === 1 && res.json.has_more === true, res.text);
  const firstPage = res.json.authorizations[0].authorization_id;
  res = await get('/authorizations?limit=1&offset=1', { token: t.ada });
  check('offset moves the page forward', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id !== firstPage, res.text);
  check('the list is newest first', firstPage === a3, firstPage);
  res = await get('/authorizations?status=bogus', { token: t.ada });
  expectError('an unknown status filter is 422', res, 422, 'validation_failed');
  res = await get('/authorizations?direction=sideways', { token: t.ada });
  expectError('an unknown direction filter is 422', res, 422, 'validation_failed');
}

// Group 13: expiry is a property of the clock, not of a request.
async function group13() {
  const expiring = fixture();
  expiring.authorizations = [
    hold('a_past', 'u_ada', 'u_bob', 3000, stamp(-7200), { note: 'old' }),
    hold('a_future', 'u_dee', 'u_bob', 1000, stamp(7200), { note: 'new' }),
    hold('a_done', 'u_ada', 'u_cy', 500, stamp(7200), { status: 'captured', captured_amount: 500 }),
    hold('a_gone', 'u_ada', 'u_cy', 500, stamp(7200), { status: 'voided' }),
  ];
  expectStatus('a fixture mixing authorization states is accepted', await post('/_test/reset', { body: expiring }), 204);
  const t = await loginAll();

  let res = await get('/me', { token: t.ada });
  check('an expired hold still counts toward the total', res.json.total === 10000 && res.json.balance === 10000, res.text);
  check('an expired hold releases its money', res.json.held === 0 && res.json.available === 10000, res.text);
  res = await get('/me', { token: t.dee });
  check('an unexpired hold is still held', res.json.held === 1000 && res.json.available === 0, res.text);

  res = await get('/authorizations?status=expired', { token: t.ada });
  check('status=expired finds the past-due hold', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id === 'a_past' && res.json.authorizations[0].status === 'expired', res.text);
  res = await get('/authorizations?status=open', { token: t.ada });
  check('an expired hold never appears open', res.json.authorizations.length === 0, res.text);
  res = await get('/authorizations', { token: t.dee });
  check('a held but unexpired authorization reads open', res.json.authorizations.length === 1 && res.json.authorizations[0].status === 'open', res.text);
  res = await get('/authorizations', { token: t.ada });
  check('a captured seed reads captured', res.json.authorizations.some((item) => item.authorization_id === 'a_done' && item.status === 'captured'), res.text);
  check('a voided seed reads voided', res.json.authorizations.some((item) => item.authorization_id === 'a_gone' && item.status === 'voided'), res.text);

  res = await post('/authorizations/a_past/capture', { token: t.bob, key: 'exp-cap', body: { amount: 100 } });
  expectError('capturing an expired authorization is 409 authorization_expired', res, 409, 'authorization_expired');
  res = await post('/authorizations/a_past/void', { token: t.ada, body: {} });
  expectError('voiding an expired authorization is 409 authorization_not_open', res, 409, 'authorization_not_open');
  res = await post('/authorizations/a_done/capture', { token: t.cy, key: 'done-cap', body: { amount: 100 } });
  expectError('capturing a captured authorization is 409 authorization_not_open', res, 409, 'authorization_not_open');
  res = await get('/me', { token: t.ada });
  check('reads keep reflecting expiry without a request touching the deadline', res.json.held === 0 && res.json.available === 10000, res.text);
}
// Group 14: the browser screens, the shared URLs and the money formatting.
async function group14() {
  await post('/_test/reset', { body: fixture() });

  let res = await raw('GET', '/', { headers: { Accept: 'text/html' } });
  expectStatus('GET / returns the wallet screen', res, 200);
  check('the wallet is served as HTML', res.contentType.includes('text/html'), res.contentType);
  check('the page loads its own script and stylesheet', res.text.includes('/app.js') && res.text.includes('/styles.css'), '');
  check('a signed-out wallet shows no user chip', !hasTestId(res.text, 'current-user'), '');
  check('a signed-out wallet invites the visitor to sign in', res.text.includes('Sign in'), '');

  res = await raw('POST', '/auth/login', { headers: { Accept: 'text/html' }, body: { email: 'ada@example.com', password: PASSWORD } });
  expectStatus('the login endpoint answers with a body', res, 200);
  const setCookie = res.headers.get('set-cookie') || '';
  check('login sets an http-only session cookie', /pocketful_token=/.test(setCookie) && /httponly/i.test(setCookie), setCookie);
  const sessionToken = JSON.parse(res.text).token;
  const cookie = 'pocketful_token=' + sessionToken;

  res = await raw('GET', '/', { cookie });
  check('the wallet shows the available headline and the total', hasTestId(res.text, 'wallet-available') && hasTestId(res.text, 'wallet-balance'), '');
  check('the wallet hides held while nothing is held', !hasTestId(res.text, 'wallet-held'), 'held was shown');
  check('the pay form is present', hasTestId(res.text, 'pay-handle') && hasTestId(res.text, 'pay-amount') && hasTestId(res.text, 'pay-note') && hasTestId(res.text, 'pay-visibility') && hasTestId(res.text, 'pay-submit'), '');
  check('the request form is present', hasTestId(res.text, 'request-handle') && hasTestId(res.text, 'request-amount') && hasTestId(res.text, 'request-note') && hasTestId(res.text, 'request-submit'), '');
  check('the authorise form is present', hasTestId(res.text, 'authorize-handle') && hasTestId(res.text, 'authorize-amount') && hasTestId(res.text, 'authorize-note') && hasTestId(res.text, 'authorize-visibility') && hasTestId(res.text, 'authorize-submit'), '');
  check('the wallet offers an explicit refresh', hasTestId(res.text, 'wallet-refresh'), '');

  res = await raw('GET', '/', { cookie });
  check('a signed-in wallet shows the user chip', hasTestId(res.text, 'current-user') && hasTestId(res.text, 'current-handle') && hasTestId(res.text, 'logout-button'), '');
  check('the handle element carries the bare handle', testIdText(res.text, 'current-handle') === 'ada', String(testIdText(res.text, 'current-handle')));
  check('the user element carries the display name', testIdText(res.text, 'current-user') === 'Ada', String(testIdText(res.text, 'current-user')));
  check('the balance is formatted for people', testIdText(res.text, 'wallet-balance') === '100.00 EUR', String(testIdText(res.text, 'wallet-balance')));
  check('available equals the total while nothing is held', testIdText(res.text, 'wallet-available') === '100.00 EUR', String(testIdText(res.text, 'wallet-available')));

  const heldFixture = fixture();
  heldFixture.authorizations = [hold('a_ui', 'u_ada', 'u_bob', 2000, stamp(7200))];
  expectStatus('the hold fixture is accepted', await post('/_test/reset', { body: heldFixture }), 204);
  const t2 = await loginAll();
  res = await raw('GET', '/', { cookie: 'pocketful_token=' + t2.ada });
  check('held funds are shown beside the total', testIdText(res.text, 'wallet-held') === '20.00 EUR', String(testIdText(res.text, 'wallet-held')));
  check('available is the headline spending number', testIdText(res.text, 'wallet-available') === '80.00 EUR', String(testIdText(res.text, 'wallet-available')));
  check('the total keeps the existing formatted balance', testIdText(res.text, 'wallet-balance') === '100.00 EUR', String(testIdText(res.text, 'wallet-balance')));

  res = await raw('GET', '/requests', { headers: { Accept: 'text/html' }, cookie: 'pocketful_token=' + t2.ada });
  expectStatus('GET /requests returns the screen for a browser', res, 200);
  check('the request screen is HTML with both lists', res.contentType.includes('text/html') && hasTestId(res.text, 'incoming-list') && hasTestId(res.text, 'outgoing-list'), res.contentType);
  res = await raw('GET', '/requests', { token: t2.ada });
  check('the same request URL serves JSON without the HTML accept header', res.text.includes('"requests"') && res.text.includes('"has_more"'), res.text.slice(0, 120));

  res = await raw('GET', '/authorizations', { headers: { Accept: 'text/html' }, cookie: 'pocketful_token=' + t2.bob });
  expectStatus('GET /authorizations returns the screen', res, 200);
  check('the authorization list renders the hold', hasTestId(res.text, 'authorization-list') && hasTestId(res.text, 'authorization-item-a_ui'), res.text.slice(0, 160));
  check('the item carries its status', res.text.includes('data-testid="authorization-item-a_ui" data-status="open"'), '');
  check('an incoming open authorization offers capture', hasTestId(res.text, 'authorization-capture-a_ui') && hasTestId(res.text, 'authorization-capture-amount-a_ui'), '');
  check('the capture amount is prefilled with the remainder', res.text.includes('data-testid="authorization-capture-amount-a_ui" value="20.00"'), 'not prefilled');
  check('the authorized amount is formatted', testIdText(res.text, 'authorization-amount-a_ui') === '20.00 EUR', String(testIdText(res.text, 'authorization-amount-a_ui')));
  check('the expiry is the raw RFC 3339 stamp', testIdText(res.text, 'authorization-expires-a_ui') === heldFixture.authorizations[0].expires_at, String(testIdText(res.text, 'authorization-expires-a_ui')));
  check('a captured amount is absent while open', !hasTestId(res.text, 'authorization-captured-a_ui'), '');
  res = await raw('GET', '/authorizations', { headers: { Accept: 'text/html' }, cookie: 'pocketful_token=' + t2.ada });
  check('an outgoing open authorization offers a release instead of a capture', hasTestId(res.text, 'authorization-void-a_ui') && !hasTestId(res.text, 'authorization-capture-a_ui'), '');
  res = await raw('GET', '/authorizations', { token: t2.bob });
  check('the authorization URL serves JSON without the HTML accept header', res.text.includes('"authorizations"'), res.text.slice(0, 120));

  res = await raw('GET', '/split', { headers: { Accept: 'text/html' } });
  expectStatus('GET /split returns the split screen', res, 200);
  check('the split form has an amount, handles, note and preview', hasTestId(res.text, 'split-amount') && hasTestId(res.text, 'split-handles') && hasTestId(res.text, 'split-note') && hasTestId(res.text, 'split-submit') && hasTestId(res.text, 'split-preview'), '');
  res = await raw('GET', '/login', { headers: { Accept: 'text/html' } });
  check('the login screen has its inputs', hasTestId(res.text, 'login-email') && hasTestId(res.text, 'login-password') && hasTestId(res.text, 'login-submit'), '');
  res = await raw('GET', '/signup', { headers: { Accept: 'text/html' } });
  check('the signup screen has its inputs', hasTestId(res.text, 'signup-email') && hasTestId(res.text, 'signup-password') && hasTestId(res.text, 'signup-display-name') && hasTestId(res.text, 'signup-submit'), '');
  check('a signed-out screen shows no user chip', !hasTestId(res.text, 'current-user'), '');
  res = await raw('GET', '/app.js', {});
  expectStatus('the browser script is served', res, 200);
  res = await raw('GET', '/styles.css', {});
  expectStatus('the stylesheet is served', res, 200);

  check('minor_units 2 prints two decimals', stage2Views.formatAmount(10000, 2, 'EUR') === '100.00 EUR', stage2Views.formatAmount(10000, 2, 'EUR'));
  check('minor_units 0 prints no decimal point', stage2Views.formatAmount(1200, 0, 'JPY') === '1200 JPY', stage2Views.formatAmount(1200, 0, 'JPY'));
  check('minor_units 3 prints three decimals', stage2Views.formatAmount(2500, 3, 'BHD') === '2.500 BHD', stage2Views.formatAmount(2500, 3, 'BHD'));
  check('a zero balance is still formatted', stage2Views.formatAmount(0, 2, 'EUR') === '0.00 EUR', stage2Views.formatAmount(0, 2, 'EUR'));
  check('decimal input becomes minor units', stage2Views.parseDecimal('15.00', 2) === 1500 && stage2Views.parseDecimal('15', 2) === 1500 && stage2Views.parseDecimal('15.5', 2) === 1550, '');
  check('more decimal places than the currency are rejected', stage2Views.parseDecimal('15.005', 2) === null, '');
  check('non numeric input is rejected', stage2Views.parseDecimal('abc', 2) === null && stage2Views.parseDecimal('', 2) === null, '');
  check('the split shares follow the stage 1 rule', JSON.stringify(stage2Views.computeShares(100, 3)) === JSON.stringify([34, 33, 33]), JSON.stringify(stage2Views.computeShares(100, 3)));
  check('the split shares always sum to the amount', stage2Views.computeShares(1000, 7).reduce((sum, value) => sum + value, 0) === 1000, '');

  // The shares the browser previews must be the shares the server records.
  const previewHandles = ['bob', 'cy', 'dee'];
  const previewAmounts = stage2Views.computeShares(1234, previewHandles.length);
  res = await post('/splits', { token: t2.bob, key: 'ui-split-1', body: { amount: 1234, participant_handles: previewHandles, note: 'dinner' } });
  expectStatus('the split is accepted', res, 201);
  check('the submitted shares equal the preview', JSON.stringify(res.json.shares.map((share) => share.amount)) === JSON.stringify(previewAmounts), res.text);
  check('the preview shares sum to the amount', previewAmounts.reduce((sum, value) => sum + value, 0) === 1234, JSON.stringify(previewAmounts));
}
// Group 15: the upgrade from a stage 1 service and a browser that stays signed in.
async function group15() {
  await post('/_test/reset', { body: fixture() });
  const t = await loginAll();

  let res = await post('/requests', { token: t.bob, key: 'up-rq', body: { payer_handle: 'dee', amount: 300, note: 'lunch' } });
  expectStatus('the pre-upgrade request is created', res, 201);
  const requestId = res.json.request_id;

  res = await post('/authorizations', { token: t.ada, key: 'up-au', body: { to_handle: 'bob', amount: 2000, note: 'trip', visibility: 'public' } });
  expectStatus('the pre-upgrade authorization is created', res, 201);
  const authorizationId = res.json.authorization_id;

  // A payment whose response was lost: the write committed, the caller never saw it.
  res = await post('/payments', { token: t.ada, key: 'up-lost', body: { to_handle: 'cy', amount: 250, note: 'lost', visibility: 'public' } });
  expectStatus('the lost-response payment did commit', res, 201);
  const lostPaymentId = res.json.payment_id;
  const lostPaymentBody = res.text;

  const exported = await get('/_test/export', { token: t.ada });
  expectStatus('export is 200', exported, 200);
  const document = exported.json;
  check('the export carries the authorization ttl', document.state.authorization_ttl_seconds === 600, JSON.stringify(document.state.authorization_ttl_seconds));

  // The same service must accept an export produced by stage 1, which has no
  // authorizations and no ttl at all.
  const stageOneExport = JSON.parse(JSON.stringify(document));
  delete stageOneExport.state.authorizations;
  delete stageOneExport.state.authorization_ttl_seconds;
  expectStatus('a stage 1 export imports cleanly', await post('/_test/import', { body: JSON.stringify(stageOneExport) }), 204);
  res = await get('/me', { token: t.ada });
  check('the signed-in session survives the upgrade', res.status === 200, res.text);
  check('an imported stage 1 state has no holds', res.json.balance === 9750 && res.json.held === 0 && res.json.available === 9750, res.text);
  res = await get('/authorizations', { token: t.ada });
  check('a stage 1 import means an empty authorization list', res.json.authorizations.length === 0, res.text);

  expectStatus('the stage 2 export re-imports', await post('/_test/import', { body: JSON.stringify(document) }), 204);
  res = await get('/me', { token: t.ada });
  check('an imported open hold is held again', res.json.total === 9750 && res.json.held === 2000 && res.json.available === 7750, res.text);
  res = await get('/authorizations', { token: t.ada });
  check('the imported authorization is readable', res.json.authorizations.length === 1 && res.json.authorizations[0].authorization_id === authorizationId, res.text);
  check('the imported authorization kept its ttl', Date.parse(res.json.authorizations[0].expires_at) - Date.parse(res.json.authorizations[0].created_at) === 600000, res.text);

  const page = await raw('GET', '/', { cookie: 'pocketful_token=' + t.ada });
  check('the browser signed in before the upgrade is still signed in', testIdText(page.text, 'current-handle') === 'ada', String(testIdText(page.text, 'current-handle')));

  res = await post('/requests/' + requestId + '/pay', { token: t.dee, key: 'up-pay', body: {} });
  expectStatus('a pending request is still payable after the upgrade', res, 201);

  const before = await get('/me', { token: t.ada });
  const retry = await post('/payments', { token: t.ada, key: 'up-lost', body: { to_handle: 'cy', amount: 250, note: 'lost', visibility: 'public' } });
  check('the lost response replays after the upgrade', retry.status === 200 && retry.text === lostPaymentBody, retry.status + ' ' + retry.text.slice(0, 140));
  const after = await get('/me', { token: t.ada });
  check('the recovered payment moved the money exactly once', before.json.balance === after.json.balance && after.json.balance === 9750, before.text + ' -> ' + after.text);
  const feed = await get('/activity?limit=200', { token: t.ada });
  check('the recovered payment appears exactly once', feed.json.payments.filter((payment) => payment.payment_id === lostPaymentId).length === 1, '');
  const pageAfter = await raw('GET', '/', { cookie: 'pocketful_token=' + t.ada });
  check('the recovered payment reaches the browser wallet feed', pageAfter.text.includes('activity-item-' + lostPaymentId), 'missing from the feed');
}