'use strict';

const { HttpError, fail } = require('./errors');
const { isPlainObject } = require('./util');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_COOKIE = 'pocketful_token';

function sendJson(res, status, body, headers) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  }, headers || {}));
  res.end(payload);
}

// HTML and static bytes are sent verbatim; the browser renders them as served.
function sendHtml(res, status, html, headers) {
  const payload = Buffer.from(html, 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
  }, headers || {}));
  res.end(payload);
}

function sendText(res, status, text, contentType, headers) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': contentType,
    'Content-Length': payload.length,
  }, headers || {}));
  res.end(payload);
}

// A browser navigation sends text/html; every API client that does not gets JSON.
function wantsHtml(req) {
  const accept = req.headers['accept'];
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

function readCookie(req, name) {
  const header = req.headers['cookie'];
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch (error) {
        return null;
      }
    }
  }
  return null;
}

function sendNoContent(res, headers) {
  res.writeHead(204, Object.assign({ 'Content-Length': '0' }, headers || {}));
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
  if (result.status === 204) sendNoContent(res, result.headers);
  else if (typeof result.html === 'string') sendHtml(res, result.status, result.html, result.headers);
  else if (typeof result.text === 'string') sendText(res, result.status, result.text, result.contentType || 'text/plain; charset=utf-8', result.headers);
  else sendJson(res, result.status, result.body, result.headers);
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

module.exports = {
  sendJson,
  sendHtml,
  sendText,
  sendNoContent,
  sendError,
  sendResult,
  readRawBody,
  parseJsonBody,
  wantsHtml,
  readCookie,
  SESSION_COOKIE,
};