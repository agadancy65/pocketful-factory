'use strict';

const http = require('http');
const { HttpError, fail } = require('./errors');
const { sendResult, sendError, readRawBody, parseJsonBody, wantsHtml, readCookie, SESSION_COOKIE } = require('./http');
const api = require('./api');
const store = require('./store');
const stateLib = require('./state');
const demo = require('./demo');

const routes = [
  { method: 'GET', pattern: /^\/health$/, handler: api.health },
  { method: 'GET', pattern: /^\/styles\.css$/, handler: api.stylesheet },
  { method: 'GET', pattern: /^\/app\.js$/, handler: api.appScript },
  { method: 'GET', pattern: /^\/views\.js$/, handler: api.viewsScript },
  { method: 'GET', pattern: /^\/$/, handler: api.walletPage },
  { method: 'GET', pattern: /^\/login$/, handler: api.loginPage },
  { method: 'GET', pattern: /^\/signup$/, handler: api.signupPage },
  { method: 'GET', pattern: /^\/split$/, handler: api.splitPage },
  { method: 'POST', pattern: /^\/auth\/logout$/, handler: api.logout },
  { method: 'POST', pattern: /^\/_test\/reset$/, handler: api.reset, body: true },
  { method: 'GET', pattern: /^\/_test\/export$/, handler: api.exportState },
  { method: 'POST', pattern: /^\/_test\/import$/, handler: api.importState, body: true },
  { method: 'POST', pattern: /^\/auth\/signup$/, handler: api.signup, body: true },
  { method: 'POST', pattern: /^\/auth\/login$/, handler: api.login, body: true },
  { method: 'GET', pattern: /^\/me$/, handler: api.me, auth: true },
  { method: 'GET', pattern: /^\/statement$/, handler: api.statement, auth: true },
  { method: 'GET', pattern: /^\/payments\/([^/]+)\/revisions$/, handler: api.listRevisions, auth: true },
  { method: 'POST', pattern: /^\/payments\/([^/]+)\/corrections$/, handler: api.correctPayment, auth: true, body: true },
  { method: 'POST', pattern: /^\/payments\/([^/]+)\/refunds$/, handler: api.refundPayment, auth: true, body: true },
  { method: 'POST', pattern: /^\/correction-batches$/, handler: api.createCorrectionBatch, auth: true, body: true },
  { method: 'POST', pattern: /^\/payments$/, handler: api.createPayment, auth: true, body: true },
  { method: 'POST', pattern: /^\/requests$/, handler: api.createRequest, auth: true, body: true },
  { method: 'GET', pattern: /^\/requests$/, handler: api.listRequests, auth: true, html: api.requestsPage },
  { method: 'GET', pattern: /^\/authorizations$/, handler: api.listAuthorizations, auth: true, html: api.authorizationsPage },
  { method: 'POST', pattern: /^\/authorizations$/, handler: api.createAuthorization, auth: true, body: true },
  { method: 'POST', pattern: /^\/authorizations\/([^/]+)\/capture$/, handler: api.captureAuthorization, auth: true, body: true },
  { method: 'POST', pattern: /^\/authorizations\/([^/]+)\/void$/, handler: api.voidAuthorization, auth: true, body: true },
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

function bearerToken(req) {
  const header = req.headers['authorization'];
  const match = typeof header === 'string' ? /^Bearer[ \t]+(.+)$/i.exec(header.trim()) : null;
  return match ? match[1].trim() : null;
}

function userForToken(state, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const userId = state.tokens.get(token);
  if (userId === undefined) return null;
  return state.users.get(userId) || null;
}

function authenticate(state, req) {
  const token = bearerToken(req);
  if (token === null || token.length === 0) fail(401, 'unauthenticated', 'A bearer token is required');
  const user = userForToken(state, token);
  if (!user) fail(401, 'unauthenticated', 'Unknown bearer token');
  return user;
}

// Screens sign a browser in with the cookie the login screen set; the bearer
// token still works, so the same URL serves the API and the UI.
function optionalSession(state, req) {
  let token = bearerToken(req);
  if (userForToken(state, token) === null) {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie !== null && userForToken(state, cookie) !== null) token = cookie;
  }
  const user = userForToken(state, token);
  return { user, token: user === null ? null : token };
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

  // A brand new process seeds the demo accounts before its first handler runs.
  await ensureDemoState();
  // The state may have been replaced while the body was being read.
  const state = store.get();
  // Accept: text/html asks for the screen; every other client gets JSON.
  const wantsUi = route.html !== undefined && wantsHtml(req);
  const handler = wantsUi ? route.html : route.handler;
  const session = optionalSession(state, req);
  let user = null;
  if (route.auth && !wantsUi) user = authenticate(state, req);

  const ctx = {
    state,
    user,
    session,
    body,
    url,
    params,
    method: req.method,
    path,
    idempotencyKey: req.headers['idempotency-key'],
  };
  sendResult(res, await handler(ctx));
}

// A service that has never been reset or imported starts with the five demo
// accounts, so the screens and the API are usable the moment it is up. No
// handler runs until the seed has settled, and the seed only ever fills an empty
// store, so a reset or an import still wins.
let seedPromise = null;

function ensureDemoState() {
  if (store.get() !== null) return Promise.resolve();
  if (seedPromise === null) {
    seedPromise = stateLib.stateFromFixture(demo.demoFixture()).then(
      (next) => {
        if (store.get() === null) store.set(next);
        seedPromise = null;
      },
      (error) => {
        seedPromise = null;
        throw error;
      }
    );
  }
  return seedPromise;
}

// Start the seed as the process starts; every request awaits the same promise.
ensureDemoState().catch((error) => {
  process.stderr.write('demo seed failed: ' + (error && error.message ? error.message : String(error)) + '\n');
});

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