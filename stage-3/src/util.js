'use strict';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Canonical form of a parsed JSON value: key order and whitespace do not matter,
// so two bodies are "the same body" exactly when their canonical forms match.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    parts.push(JSON.stringify(key) + ':' + canonicalJson(value[key]));
  }
  return '{' + parts.join(',') + '}';
}

function codePointLength(text) {
  return Array.from(text).length;
}

module.exports = { isPlainObject, canonicalJson, codePointLength };