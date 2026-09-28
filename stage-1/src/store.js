'use strict';

// The live state is replaced atomically by reset and import. Handlers always
// read it through get() at the moment they act on it.
let current = null;

function get() {
  return current;
}

function set(next) {
  current = next;
}

module.exports = { get, set };