'use strict';

// Stage 3 temporal queries. Two clocks matter: when money took effect
// (effective_at) and when the service learned that fact (recorded_at).

function msOf(instant) {
  return Date.parse(instant);
}

// The revision in force at knownAtMs: the latest one recorded at or before it.
// A null knownAtMs means "everything known now", i.e. the newest revision.
function selectedRevision(payment, knownAtMs) {
  const revisions = payment.revisions;
  if (!revisions || revisions.length === 0) return null;
  if (knownAtMs === null || knownAtMs === undefined) return revisions[revisions.length - 1];
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    if (msOf(revisions[index].recorded_at) <= knownAtMs) return revisions[index];
  }
  return null;
}

function signedFor(userId, payment, revision) {
  if (payment.from_user_id === userId) return -revision.amount;
  if (payment.to_user_id === userId) return revision.amount;
  return 0;
}

function involves(payment, userId) {
  return payment.from_user_id === userId || payment.to_user_id === userId;
}

// The wallet total at an instant: the opening balance plus every selected
// movement whose effective time is at or before it.
function totalAt(state, userId, atMs, knownAtMs) {
  const user = state.users.get(userId);
  if (!user) return 0;
  let total = user.opening;
  for (const payment of state.payments.values()) {
    if (!involves(payment, userId)) continue;
    const revision = selectedRevision(payment, knownAtMs);
    if (revision === null) continue;
    if (msOf(revision.effective_at) > atMs) continue;
    total += signedFor(userId, payment, revision);
  }
  return total;
}

// The wallet total just before an instant: the balance with no movement at the
// instant itself. Statements use this for their window edges.
function balanceBefore(state, userId, atMs, knownAtMs) {
  const user = state.users.get(userId);
  if (!user) return 0;
  let total = user.opening;
  for (const payment of state.payments.values()) {
    if (!involves(payment, userId)) continue;
    const revision = selectedRevision(payment, knownAtMs);
    if (revision === null) continue;
    if (msOf(revision.effective_at) >= atMs) continue;
    total += signedFor(userId, payment, revision);
  }
  return total;
}

// What one authorisation still holds at an instant. Creation starts the hold; a
// nonfinal capture reduces it; a final capture, a void or the expiry deadline
// releases whatever remains.
function heldFromAuthorization(authorization, atMs, knownAtMs) {
  const createdAt = msOf(authorization.created_at);
  if (Number.isNaN(createdAt) || createdAt > atMs) return 0;
  if (knownAtMs !== null && knownAtMs !== undefined && createdAt > knownAtMs) return 0;
  let remaining = authorization.amount;
  const events = (authorization.hold_events || []).slice().sort((left, right) => msOf(left.at) - msOf(right.at));
  for (const event of events) {
    const at = msOf(event.at);
    if (at > atMs) break;
    if (knownAtMs !== null && knownAtMs !== undefined && at > knownAtMs) break;
    if (event.release) return 0;
    remaining -= event.amount;
    if (remaining < 0) remaining = 0;
  }
  if (remaining > 0) {
    const expiresAt = msOf(authorization.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= atMs) return 0;
  }
  return remaining;
}

function heldAt(state, userId, atMs, knownAtMs) {
  let held = 0;
  for (const authorization of state.authorizations.values()) {
    if (authorization.from_user_id !== userId) continue;
    held += heldFromAuthorization(authorization, atMs, knownAtMs);
  }
  return held;
}

// Every instant at which some wallet's total or available can change.
function boundaryInstants(state) {
  const instants = [Number.NEGATIVE_INFINITY];
  for (const payment of state.payments.values()) {
    const revisions = payment.revisions;
    if (!revisions || revisions.length === 0) continue;
    instants.push(msOf(revisions[revisions.length - 1].effective_at));
  }
  for (const authorization of state.authorizations.values()) {
    instants.push(msOf(authorization.created_at));
    for (const event of authorization.hold_events || []) instants.push(msOf(event.at));
    instants.push(msOf(authorization.expires_at));
  }
  return instants.filter((value) => !Number.isNaN(value));
}

// True when no wallet is negative - in total or available - at any boundary.
// This is the guard a correction must pass before it is accepted.
function historyIsNonnegative(state) {
  const instants = boundaryInstants(state);
  for (const userId of state.users.keys()) {
    for (const instant of instants) {
      const total = totalAt(state, userId, instant, null);
      if (total < 0) return false;
      if (total - heldAt(state, userId, instant, null) < 0) return false;
    }
  }
  return true;
}

// The payments that belong in a statement window, ordered by the selected
// effective time and then by payment id.
function statementEntries(state, userId, fromMs, toMs, knownAtMs) {
  const entries = [];
  for (const payment of state.payments.values()) {
    if (!involves(payment, userId)) continue;
    const revision = selectedRevision(payment, knownAtMs);
    if (revision === null) continue;
    const effectiveAt = msOf(revision.effective_at);
    if (effectiveAt < fromMs || effectiveAt >= toMs) continue;
    entries.push({ payment, revision, effectiveAt });
  }
  entries.sort((left, right) => {
    if (left.effectiveAt !== right.effectiveAt) return left.effectiveAt - right.effectiveAt;
    if (left.payment.payment_id < right.payment.payment_id) return -1;
    if (left.payment.payment_id > right.payment.payment_id) return 1;
    return 0;
  });
  return entries;
}

module.exports = {
  msOf,
  selectedRevision,
  signedFor,
  involves,
  totalAt,
  balanceBefore,
  heldFromAuthorization,
  heldAt,
  boundaryInstants,
  historyIsNonnegative,
  statementEntries,
};