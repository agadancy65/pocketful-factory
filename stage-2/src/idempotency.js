'use strict';

const { fail } = require('./errors');
const { canonicalJson } = require('./util');
const { MAX_IDEMPOTENCY_KEY_LENGTH } = require('./validate');

// A key is scoped to the caller and to the method and path it was used on.
function memoIdentity(userId, method, path, key) {
  return [userId, method, path, key].join('\u0000');
}

// Called after authentication and body parsing, before field validation and
// before any resource check, so a claimed key always resolves first.
function claim(state, user, method, path, key, body) {
  if (typeof key !== 'string' || key.length === 0) {
    fail(400, 'missing_idempotency_key', 'The Idempotency-Key header is required');
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fail(422, 'validation_failed', 'Idempotency-Key must be 1 to ' + MAX_IDEMPOTENCY_KEY_LENGTH + ' characters');
  }
  const identity = memoIdentity(user.user_id, method, path, key);
  const canonical = canonicalJson(body);
  const existing = state.idempotency.get(identity);
  if (existing) {
    if (existing.canonical !== canonical) {
      fail(409, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request body');
    }
    return { replay: true, status: 200, body: JSON.parse(existing.body) };
  }
  return {
    replay: false,
    // Failed requests never claim the key, so they can be retried with it.
    commit(status, responseBody) {
      state.idempotency.set(identity, {
        canonical,
        status,
        body: JSON.stringify(responseBody),
      });
    },
  };
}

module.exports = { claim, memoIdentity };