'use strict';

// Server-rendered screens. Every screen is a complete HTML document so a
// browser (or a test client) can reach it by URL without running scripts; the
// browser script then keeps the same markup up to date in place.
const V = require('./views');

const NAV = [
  ['/', 'Wallet'],
  ['/requests', 'Requests'],
  ['/split', 'Split'],
  ['/authorizations', 'Authorizations'],
];

function layout(options) {
  const session = options.session;
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push('<title>' + V.esc(options.title) + ' &middot; Pocketful</title>');
  parts.push('<link rel="stylesheet" href="/styles.css">');
  parts.push('</head>');
  const attributes = [
    'data-page="' + V.esc(options.page) + '"',
    'data-currency="' + V.esc(session.currency) + '"',
    'data-minor-units="' + V.esc(session.minorUnits) + '"',
    'data-token="' + V.esc(session.token === null ? '' : session.token) + '"',
    'data-handle="' + V.esc(session.user === null ? '' : session.user.handle) + '"',
  ];
  parts.push('<body ' + attributes.join(' ') + '>');
  parts.push('<header class="topbar">');
  parts.push('<a class="brand" href="/">Pocketful</a>');
  parts.push('<nav class="nav">');
  for (const link of NAV) {
    parts.push('<a href="' + link[0] + '"' + (options.page === link[0] ? ' aria-current="page"' : '') + '>' + link[1] + '</a>');
  }
  parts.push('</nav>');
  parts.push('<div class="session">');
  if (session.user === null) {
    parts.push('<a class="link" href="/login">Sign in</a>');
    parts.push('<a class="button button-quiet" href="/signup">Sign up</a>');
  } else {
    parts.push('<span class="who" data-testid="current-user">' + V.esc(session.user.display_name) + '</span>');
    parts.push('<span class="handle" data-testid="current-handle">' + V.esc(session.user.handle) + '</span>');
    parts.push('<button type="button" class="button button-quiet" data-testid="logout-button">Sign out</button>');
  }
  parts.push('</div>');
  parts.push('</header>');
  parts.push('<main class="page">');
  parts.push(options.content);
  parts.push('</main>');
  parts.push('<script src="/views.js"></script>');
  parts.push('<script src="/app.js"></script>');
  parts.push('</body>');
  parts.push('</html>');
  return parts.join('\n');
}

function walletCard(user) {
  return '<section class="card wallet-card" id="wallet-card">' + V.walletHtml(user, user.minor_units, user.currency) + '</section>';
}

function signedOutNotice() {
  return '<section class="card"><h2>Sign in to use Pocketful</h2>'
    + '<p>Your wallet, requests and holds appear here once you sign in.</p>'
    + '<p><a class="button" href="/login">Sign in</a> <a class="button button-quiet" href="/signup">Create an account</a></p></section>';
}

function payForm() {
  return [
    '<section class="card">',
    '<h2>Send money</h2>',
    '<form id="pay-form" novalidate>',
    '<label class="field"><span>Recipient handle</span><input class="input" type="text" data-testid="pay-handle" placeholder="@bob" autocomplete="off" spellcheck="false"></label>',
    '<label class="field"><span>Amount</span><input class="input" type="text" inputmode="decimal" data-testid="pay-amount" placeholder="0.00" autocomplete="off"></label>',
    '<label class="field"><span>Note</span><input class="input" type="text" data-testid="pay-note" placeholder="What is it for? (optional)" autocomplete="off"></label>',
    '<label class="field"><span>Visibility</span><select class="input" data-testid="pay-visibility"><option value="public">public</option><option value="private">private</option></select></label>',
    '<div class="messages" id="pay-messages"></div>',
    '<button class="button" type="submit" data-testid="pay-submit">Send payment</button>',
    '</form>',
    '</section>',
  ].join('\n');
}

function requestForm() {
  return [
    '<section class="card">',
    '<h2>Request money</h2>',
    '<form id="request-form" novalidate>',
    '<label class="field"><span>Their handle</span><input class="input" type="text" data-testid="request-handle" autocomplete="off" spellcheck="false"></label>',
    '<label class="field"><span>Amount</span><input class="input" type="text" inputmode="decimal" data-testid="request-amount" autocomplete="off"></label>',
    '<label class="field"><span>Note</span><input class="input" type="text" data-testid="request-note" autocomplete="off"></label>',
    '<div class="messages" id="request-messages"></div>',
    '<button class="button" type="submit" data-testid="request-submit">Send request</button>',
    '</form>',
    '</section>',
  ].join('\n');
}

function authorizeForm() {
  return [
    '<section class="card">',
    '<h2>Reserve money for later</h2>',
    '<p class="hint">An authorisation holds part of your available balance until the other person collects it, you release it, or it expires.</p>',
    '<form id="authorize-form" novalidate>',
    '<label class="field"><span>Recipient handle</span><input class="input" type="text" data-testid="authorize-handle" autocomplete="off" spellcheck="false"></label>',
    '<label class="field"><span>Amount</span><input class="input" type="text" inputmode="decimal" data-testid="authorize-amount" autocomplete="off"></label>',
    '<label class="field"><span>Note</span><input class="input" type="text" data-testid="authorize-note" autocomplete="off"></label>',
    '<label class="field"><span>Visibility</span><select class="input" data-testid="authorize-visibility"><option value="public">public</option><option value="private">private</option></select></label>',
    '<div class="messages" id="authorize-messages"></div>',
    '<button class="button" type="submit" data-testid="authorize-submit">Reserve</button>',
    '</form>',
    '</section>',
  ].join('\n');
}

function activityCard(payments, session) {
  return '<section class="card"><h2>Activity</h2><div id="activity-card">'
    + V.activityHtml(payments, session.minorUnits, session.currency)
    + '</div></section>';
}

function renderWallet(session, data) {
  const content = [
    session.user === null ? signedOutNotice() : walletCard(session.user),
    session.user === null ? '' : '<div class="toolbar"><button type="button" class="button button-quiet" id="wallet-refresh" data-testid="wallet-refresh">Refresh</button></div>',
    session.user === null ? '' : payForm(),
    session.user === null ? '' : requestForm(),
    session.user === null ? '' : authorizeForm(),
    session.user === null ? '' : activityCard(data.payments, session),
  ].join('\n');
  return layout({ title: 'Wallet', page: 'wallet', session, content });
}

function renderRequests(session, data) {
  const content = [
    session.user === null ? signedOutNotice() : walletCard(session.user),
    '<section class="card"><h2>Requests</h2><div class="messages" id="requests-messages"></div><div id="requests-card">'
      + V.requestsHtml(data.requests, session.user === null ? '' : session.user.handle, session.minorUnits, session.currency)
      + '</div></section>',
    session.user === null ? '' : activityCard(data.payments, session),
  ].join('\n');
  return layout({ title: 'Requests', page: 'requests', session, content });
}

function renderSplit(session, data) {
  const content = [
    session.user === null ? signedOutNotice() : walletCard(session.user),
    [
      '<section class="card">',
      '<h2>Split a bill</h2>',
      '<form id="split-form" novalidate>',
      '<label class="field"><span>Total amount</span><input class="input" type="text" inputmode="decimal" data-testid="split-amount" autocomplete="off"></label>',
      '<label class="field"><span>Handles, separated by commas</span><input class="input" type="text" data-testid="split-handles" autocomplete="off" spellcheck="false"></label>',
      '<label class="field"><span>Note</span><input class="input" type="text" data-testid="split-note" autocomplete="off"></label>',
      '<div class="messages" id="split-messages"></div>',
      '<button class="button" type="submit" data-testid="split-submit">Send split</button>',
      '</form>',
      '<div class="preview" id="split-preview" data-testid="split-preview"></div>',
      '</section>',
    ].join('\n'),
    session.user === null ? '' : activityCard(data.payments, session),
  ].join('\n');
  return layout({ title: 'Split', page: 'split', session, content });
}

function renderAuthorizations(session, data) {
  const content = [
    session.user === null ? signedOutNotice() : walletCard(session.user),
    session.user === null ? '' : authorizeForm(),
    '<section class="card"><h2>Authorisations</h2><div class="messages" id="authorizations-messages"></div><div id="authorizations-card">'
      + V.authorizationsHtml(data.authorizations, session.user === null ? '' : session.user.handle, session.minorUnits, session.currency)
      + '</div></section>',
  ].join('\n');
  return layout({ title: 'Authorizations', page: 'authorizations', session, content });
}

function renderLogin(session) {
  const content = [
    '<section class="card card-narrow">',
    '<h2>Sign in</h2>',
    '<form id="login-form" novalidate>',
    '<label class="field"><span>Email</span><input class="input" type="email" data-testid="login-email" autocomplete="email"></label>',
    '<label class="field"><span>Password</span><input class="input" type="password" data-testid="login-password" autocomplete="current-password"></label>',
    '<div class="messages" id="auth-messages"></div>',
    '<button class="button" type="submit" data-testid="login-submit">Sign in</button>',
    '</form>',
    '<p class="hint">No account yet? <a href="/signup">Create one</a>.</p>',
    '</section>',
  ].join('\n');
  return layout({ title: 'Sign in', page: 'login', session, content });
}

function renderSignup(session) {
  const content = [
    '<section class="card card-narrow">',
    '<h2>Create your account</h2>',
    '<form id="signup-form" novalidate>',
    '<label class="field"><span>Email</span><input class="input" type="email" data-testid="signup-email" autocomplete="email"></label>',
    '<label class="field"><span>Password</span><input class="input" type="password" data-testid="signup-password" autocomplete="new-password"></label>',
    '<label class="field"><span>Your name</span><input class="input" type="text" data-testid="signup-display-name" autocomplete="name"></label>',
    '<div class="messages" id="auth-messages"></div>',
    '<button class="button" type="submit" data-testid="signup-submit">Create account</button>',
    '</form>',
    '<p class="hint">Already have an account? <a href="/login">Sign in</a>.</p>',
    '</section>',
  ].join('\n');
  return layout({ title: 'Sign up', page: 'signup', session, content });
}

module.exports = { renderWallet, renderRequests, renderSplit, renderAuthorizations, renderLogin, renderSignup };
