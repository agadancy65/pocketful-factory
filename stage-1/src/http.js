'use strict';

const { HttpError, fail } = require('./errors');
const { isPlainObject } = require('./util');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function sendNoContent(res) {
  res.writeHead(204, { 'Content-Length': '0' });
  res.end();
}

function sendError(res, status, code, message) {
  const payload = Buffer.from(JSON.stringify({ error: { code, message } }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function sendResult(res, result) {
  if (result.status === 204) sendNoContent(res);
  else sendJson(res, result.status, result.body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(new HttpError(400, 'malformed_request', 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('aborted', () => finish(new HttpError(400, 'malformed_request', 'Request aborted')));
    req.on('error', (error) => finish(error));
  });
}

// An empty body is treated as an empty JSON object so that endpoints whose
// body is entirely optional accept a request without one.
function parseJsonBody(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(400, 'malformed_request', 'Request body is not valid JSON');
  }
  if (!isPlainObject(value)) fail(400, 'malformed_request', 'Request body must be a JSON object');
  return value;
}

module.exports = { sendJson, sendNoContent, sendError, sendResult, readRawBody, parseJsonBody };