'use strict';

const { fail } = require('./errors');
const { codePointLength } = require('./util');

const HANDLE_PATTERN = /^[a-z0-9_]{1,20}$/;
const MAX_AMOUNT = 1000000000;
const MAX_NOTE_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function requiredString(body, field) {
  const value = body[field];
  if (value === undefined) fail(422, 'validation_failed', field + ' is required');
  if (typeof value !== 'string') fail(400, 'malformed_request', field + ' must be a string');
  return value;
}

// Amounts are exact integer counts of minor units. JSON numbers with an
// integral value (1000, 1000.0, 1e3) are all valid; booleans and strings are not.
function amountField(body, field) {
  const name = field === undefined ? 'amount' : field;
  const value = body[name];
  if (value === undefined || value === null) fail(422, 'validation_failed', name + ' is required');
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(422, 'validation_failed', name + ' must be an integer number of minor units');
  }
  if (value < 1 || value > MAX_AMOUNT) {
    fail(422, 'validation_failed', name + ' must be between 1 and ' + MAX_AMOUNT);
  }
  return value;
}

function noteField(body, field) {
  const name = field === undefined ? 'note' : field;
  const value = body[name];
  if (value === undefined) return '';
  if (typeof value !== 'string') fail(422, 'validation_failed', name + ' must be a string');
  if (codePointLength(value) > MAX_NOTE_LENGTH) {
    fail(422, 'validation_failed', name + ' must be at most ' + MAX_NOTE_LENGTH + ' characters');
  }
  return value;
}

function visibilityField(body, field) {
  const name = field === undefined ? 'visibility' : field;
  const value = body[name];
  if (value === undefined) return 'public';
  if (value !== 'public' && value !== 'private') {
    fail(422, 'validation_failed', name + ' must be "public" or "private"');
  }
  return value;
}

// Integer query parameters are plain decimal digits; 1e9, 4.0 and +4 are invalid.
function queryParam(url, name) {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return null;
  return value;
}

function intQuery(url, name, defaultValue, min, max) {
  const raw = queryParam(url, name);
  if (raw === null) return defaultValue;
  if (!/^\d+$/.test(raw)) fail(422, 'validation_failed', name + ' must be an integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(422, 'validation_failed', name + ' is out of range');
  if (value < min) fail(422, 'validation_failed', name + ' must be at least ' + min);
  if (max !== null && max !== undefined && value > max) {
    fail(422, 'validation_failed', name + ' must be at most ' + max);
  }
  return value;
}

module.exports = {
  HANDLE_PATTERN,
  MAX_AMOUNT,
  MAX_NOTE_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  requiredString,
  amountField,
  noteField,
  visibilityField,
  queryParam,
  intQuery,
};