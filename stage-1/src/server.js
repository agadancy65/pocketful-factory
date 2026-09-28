'use strict';

const http = require('http');
const { HttpError, fail } = require('./errors');
const { sendResult, sendError, readRawBody, parseJsonBody } = require('./http');
const api = require('./api');
const store = require('./store');

const routes = [
  { method: 'GET', pattern: /^\/health$/, handler: api.health },
  { method: 'POST', pattern: /^\/_test\/reset$/, handler: api.reset, body: true },
  { method: 'GET', pattern: /^\/_test\/export$/, handler: api.exportState },
  { method: 'POST', pattern: /^\/_test\/import$/, handler: api.importState, body: true },
  { method: 'POST', pattern: /^\/auth\/signup$/, handler: api.signup, body: true },
  { method: 'POST', pattern: /^\/auth\/login$/, handler: api.login, body: true },
  { method: 'GET', pattern: /^\/me$/, handler: api.me, auth: true },
  { method: 'POST', pattern: /^\/payments$/, handler: api.createPayment, auth: true, body: true },
  { method: 'POST', pattern: /^\/requests$/, handler: api.createRequest, auth: true, body: true },
  { method: 'GET', pattern: /^\/requests$/, handler: api.listRequests, auth: true },
  { method: 'POST', pattern: /^\/requests\/([^/]+)\/pay$/, handler: api.payRequest, auth: true, body: true },
  { method: 'POST', pattern: /^\/requests\/([^/]+)\/decline$/, handler: api.declineRequest, auth: true, body: true },
  { method: 'POST', pattern: /^\/requests\/([^/]+)\/cancel$/, handler: api.cancelRequest, auth: true, body: true },
  { method: 'POST', pattern: /^\/splits$/, handler: api.createSplit, auth: true, body: true },
  { method: 'GET', pattern: /^\/activity$/, handler: api.listActivity, auth: true },
  { method: 'POST', pattern: /^\/settlements$/, handler: api.createSettlement, auth: true, body: true },
];

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const trimmed = pathname.replace(/\/+$/, '');
    return trimmed.length === 0 ? '/' : trimmed;
  }
  return pathname;
}

function authenticate(state, req) {
  const header = req.headers['authorization'];
  const match = typeof header === 'string' ? /^Bearer[ \t]+(.+)$/i.exec(header.trim()) : null;
  if (!match) fail(401, 'unauthenticated', 'A bearer token is required');
  const token = match[1].trim();
  const userId = token.length === 0 ? undefined : state.tokens.get(token);
  const user = userId === undefined ? undefined : state.users.get(userId);
  if (!user) fail(401, 'unauthenticated', 'Unknown bearer token');
  return user;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = normalizePath(url.pathname);
  const route = routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(path));
  if (!route) {
    sendError(res, 404, 'not_found', 'No such resource');
    return;
  }
  let params = [];
  const match = route.pattern.exec(path);
  if (match && match.length > 1) {
    try {
      params = match.slice(1).map((value) => decodeURIComponent(value));
    } catch (error) {
      fail(400, 'malformed_request', 'Malformed request path');
    }
  }

  let body = {};
  if (route.body) {
    body = parseJsonBody(await readRawBody(req));
  }

  // The state may have been replaced while the body was being read.
  const state = store.get();
  let user = null;
  if (route.auth) user = authenticate(state, req);

  const ctx = {
    state,
    user,
    body,
    url,
    params,
    method: req.method,
    path,
    idempotencyKey: req.headers['idempotency-key'],
  };
  sendResult(res, await route.handler(ctx));
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (error instanceof HttpError) {
      if (!res.headersSent) sendError(res, error.status, error.code, error.message);
      else res.destroy();
      return;
    }
    process.stderr.write('unexpected error: ' + (error && error.stack ? error.stack : String(error)) + '\n');
    if (!res.headersSent) sendError(res, 500, 'internal_error', 'Unexpected server error');
    else res.destroy();
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

process.on('uncaughtException', (error) => {
  process.stderr.write('uncaught exception: ' + (error && error.stack ? error.stack : String(error)) + '\n');
});
process.on('unhandledRejection', (error) => {
  process.stderr.write('unhandled rejection: ' + (error && error.stack ? error.stack : String(error)) + '\n');
});

const port = Number.parseInt(process.env.PORT || '8080', 10);
server.listen(Number.isInteger(port) && port > 0 ? port : 8080, '0.0.0.0');