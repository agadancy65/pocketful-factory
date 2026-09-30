'use strict';

// Error type carrying the HTTP status and the API error code from the spec.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

module.exports = { HttpError, fail };