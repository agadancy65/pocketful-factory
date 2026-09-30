'use strict';

// Browser behaviour for every screen. The markup is server-rendered and the
// shared views module renders the in-place refreshes, so the same helpers
// produce the same elements on both sides.
(function () {
  var V = window.PocketfulViews;
  var body = document.body;
  var page = body.getAttribute('data-page') || '';
  var token = body.getAttribute('data-token') || '';
  var currency = body.getAttribute('data-currency') || 'EUR';
  var minorUnits = Number(body.getAttribute('data-minor-units') || '2');
  var handle = body.getAttribute('data-handle') || '';

  var SIGNED_IN_PAGES = ['wallet', 'requests', 'split', 'authorizations'];

  function value(id) {
    var element = document.querySelector('[data-testid="' + id + '"]');
    return element ? element.value : '';
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (error) { json = null; }
        return { status: response.status, ok: response.ok, json: json, text: text };
      });
    });
  }

  function messageOf(result, fallback) {
    if (result && result.json && result.json.error && result.json.error.message) return result.json.error.message;
    return fallback;
  }

  function randomKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'key-' + Math.random().toString(36).slice(2) + '-' + String(Date.now());
  }

  // Error and uncertainty elements exist only while they have something to say.
  function setMessage(containerId, testid, text, className) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var existing = container.querySelector('[data-testid="' + testid + '"]');
    if (!text) { if (existing) existing.parentNode.removeChild(existing); return; }
    if (!existing) {
      existing = document.createElement('div');
      existing.setAttribute('data-testid', testid);
      existing.className = className || 'form-error';
      container.appendChild(existing);
    }
    existing.textContent = text;
  }

  // Latest refresh wins: a slow earlier read may not overwrite a newer one.
  var refreshSeq = 0;
  function refreshWallet() {
    var seq = (refreshSeq += 1);
    return Promise.all([api('/me'), api('/activity?limit=100')]).then(function (results) {
      if (seq !== refreshSeq) return;
      var walletCard = document.getElementById('wallet-card');
      if (walletCard && results[0].status === 200 && results[0].json) {
        walletCard.innerHTML = V.walletHtml(results[0].json, minorUnits, currency);
      }
      var feedCard = document.getElementById('activity-card');
      if (feedCard && results[1].status === 200 && results[1].json) {
        feedCard.innerHTML = V.activityHtml(results[1].json.payments, minorUnits, currency);
      }
    }, function () { /* a failed refresh leaves the last good numbers in place */ });
  }

  function refreshRequests() {
    return api('/requests?limit=200').then(function (result) {
      var card = document.getElementById('requests-card');
      if (!card || result.status !== 200 || !result.json) return;
      card.innerHTML = V.requestsHtml(result.json.requests, handle, minorUnits, currency);
      wireRequestButtons();
    }, function () {});
  }

  function refreshAuthorizations() {
    return api('/authorizations?limit=200').then(function (result) {
      var card = document.getElementById('authorizations-card');
      if (!card || result.status !== 200 || !result.json) return;
      card.innerHTML = V.authorizationsHtml(result.json.authorizations, handle, minorUnits, currency);
      wireAuthorizationButtons();
    }, function () {});
  }

  // ---- wallet screen ----------------------------------------------------

  // A key is reused only while the body it was claimed with is unchanged, so a
  // second submit of the same form replays instead of paying twice.
  function memoFor(state, canonical) {
    if (state.key && state.body === canonical) return state.key;
    state.key = randomKey();
    state.body = canonical;
    return state.key;
  }

  function payBody() {
    var amount = V.parseDecimal(value('pay-amount'), minorUnits);
    var payload = { to_handle: value('pay-handle'), visibility: value('pay-visibility') || 'public' };
    var note = value('pay-note');
    if (note !== '') payload.note = note;
    payload.amount = amount;
    return { payload: payload, amount: amount };
  }

  function submitPayment() {
    var draft = payBody();
    if (draft.payload.to_handle === '') {
      setMessage('pay-messages', 'pay-error', 'Enter the handle to pay.');
      return Promise.resolve();
    }
    if (draft.amount === null) {
      setMessage('pay-messages', 'pay-error', 'Enter an amount with at most ' + minorUnits + ' decimal places.');
      return Promise.resolve();
    }
    var key = memoFor(payState, JSON.stringify(draft.payload));
    setMessage('pay-messages', 'pay-error', null);
    setMessage('pay-messages', 'pay-uncertain', null);
    return api('/payments', { method: 'POST', key: key, body: draft.payload }).then(function (result) {
      if (result.ok) {
        setMessage('pay-messages', 'pay-error', null);
        setMessage('pay-messages', 'pay-uncertain', null);
        return refreshWallet();
      }
      // The service answered and refused the payment: that is a rejection,
      // not an unknown outcome.
      setMessage('pay-messages', 'pay-uncertain', null);
      setMessage('pay-messages', 'pay-error', messageOf(result, 'The payment was refused.'));
      return refreshWallet();
    }, function () {
      setMessage('pay-messages', 'pay-error', null);
      setMessage('pay-messages', 'pay-uncertain', 'We did not get an answer. Try again with the same details.', 'form-uncertain');
    });
  }

  var payState = { key: null, body: null };
  var requestState = { key: null, body: null };

  function submitRequest() {
    var amount = V.parseDecimal(value('request-amount'), minorUnits);
    if (value('request-handle') === '') {
      setMessage('request-messages', 'request-error', 'Enter the handle to ask.');
      return Promise.resolve();
    }
    if (amount === null) {
      setMessage('request-messages', 'request-error', 'Enter an amount with at most ' + minorUnits + ' decimal places.');
      return Promise.resolve();
    }
    var payload = { payer_handle: value('request-handle'), amount: amount };
    var note = value('request-note');
    if (note !== '') payload.note = note;
    var key = memoFor(requestState, JSON.stringify(payload));
    setMessage('request-messages', 'request-error', null);
    return api('/requests', { method: 'POST', key: key, body: payload }).then(function (result) {
      if (!result.ok) {
        setMessage('request-messages', 'request-error', messageOf(result, 'The request was refused.'));
      }
      return refreshWallet();
    }, function () {
      setMessage('request-messages', 'request-error', 'We did not get an answer. Try again.');
    });
  }

  function wireRequestButtons() {
    var card = document.getElementById('requests-card');
    if (!card) return;
    card.querySelectorAll('[data-testid^="request-pay-"]').forEach(function (button) {
      button.addEventListener('click', function () { actOnRequest(button, 'pay'); });
    });
    card.querySelectorAll('[data-testid^="request-decline-"]').forEach(function (button) {
      button.addEventListener('click', function () { actOnRequest(button, 'decline'); });
    });
    card.querySelectorAll('[data-testid^="request-cancel-"]').forEach(function (button) {
      button.addEventListener('click', function () { actOnRequest(button, 'cancel'); });
    });
  }

  function actOnRequest(button, action) {
    var parts = button.getAttribute('data-testid').split('-');
    var requestId = parts.slice(2).join('-');
    var options = { method: 'POST' };
    if (action === 'pay') options.key = randomKey();
    setMessage('requests-messages', 'request-error', null);
    api('/requests/' + encodeURIComponent(requestId) + '/' + action, options).then(function (result) {
      if (!result.ok) {
        setMessage('requests-messages', 'request-error', messageOf(result, 'That did not go through.'));
      }
      return Promise.all([refreshRequests(), refreshWallet()]);
    }, function () {
      setMessage('requests-messages', 'request-error', 'We did not get an answer. Try again.');
    });
  }

  // ---- split screen -----------------------------------------------------

  function splitHandles() {
    return value('split-handles').split(',').map(function (item) { return item.trim(); }).filter(function (item) { return item !== ''; });
  }

  function renderPreview() {
    var preview = document.getElementById('split-preview');
    if (!preview) return;
    var amount = V.parseDecimal(value('split-amount'), minorUnits);
    var handles = splitHandles();
    setMessage('split-messages', 'split-error', null);
    if (amount === null || handles.length === 0) { preview.innerHTML = ''; return; }
    var amounts = V.computeShares(amount, handles.length);
    var shares = handles.map(function (handleName, index) { return { handle: handleName, amount: amounts[index] }; });
    preview.innerHTML = V.splitPreviewHtml(shares, minorUnits, currency);
  }

  function submitSplit() {
    var amount = V.parseDecimal(value('split-amount'), minorUnits);
    var handles = splitHandles();
    if (amount === null) {
      setMessage('split-messages', 'split-error', 'Enter an amount with at most ' + minorUnits + ' decimal places.');
      return Promise.resolve();
    }
    if (handles.length === 0) {
      setMessage('split-messages', 'split-error', 'Enter at least one handle.');
      return Promise.resolve();
    }
    var payload = { amount: amount, participant_handles: handles };
    var note = value('split-note');
    if (note !== '') payload.note = note;
    var key = memoFor(splitState, JSON.stringify(payload));
    return api('/splits', { method: 'POST', key: key, body: payload }).then(function (result) {
      if (!result.ok) {
        setMessage('split-messages', 'split-error', messageOf(result, 'The split was refused.'));
      } else {
        setMessage('split-messages', 'split-error', null);
      }
    }, function () {
      setMessage('split-messages', 'split-error', 'We did not get an answer. Try again.');
    });
  }

  var splitState = { key: null, body: null };

  // ---- authorizations ---------------------------------------------------

  var authorizeState = { key: null, body: null };

  function submitAuthorization() {
    var amount = V.parseDecimal(value('authorize-amount'), minorUnits);
    if (value('authorize-handle') === '') {
      setMessage('authorize-messages', 'authorize-error', 'Enter the handle to reserve money for.');
      return Promise.resolve();
    }
    if (amount === null) {
      setMessage('authorize-messages', 'authorize-error', 'Enter an amount with at most ' + minorUnits + ' decimal places.');
      return Promise.resolve();
    }
    var payload = { to_handle: value('authorize-handle'), visibility: value('authorize-visibility') || 'public', amount: amount };
    var note = value('authorize-note');
    if (note !== '') payload.note = note;
    var key = memoFor(authorizeState, JSON.stringify(payload));
    setMessage('authorize-messages', 'authorize-error', null);
    return api('/authorizations', { method: 'POST', key: key, body: payload }).then(function (result) {
      if (!result.ok) {
        setMessage('authorize-messages', 'authorize-error', messageOf(result, 'The authorisation was refused.'));
      }
      return Promise.all([refreshAuthorizations(), refreshWallet()]);
    }, function () {
      setMessage('authorize-messages', 'authorize-error', 'We did not get an answer. Try again.');
    });
  }

  function wireAuthorizationButtons() {
    var card = document.getElementById('authorizations-card');
    if (!card) return;
    card.querySelectorAll('[data-testid^="authorization-capture-"]').forEach(function (button) {
      if (button.getAttribute('data-testid').indexOf('authorization-capture-amount-') === 0) return;
      button.addEventListener('click', function () {
        var id = button.getAttribute('data-testid').slice('authorization-capture-'.length);
        var input = card.querySelector('[data-testid="authorization-capture-amount-' + id + '"]');
        var amount = input ? V.parseDecimal(input.value, minorUnits) : null;
        if (amount === null) {
          setMessage('authorizations-messages', 'authorization-error', 'Enter an amount with at most ' + minorUnits + ' decimal places.');
          return;
        }
        setMessage('authorizations-messages', 'authorization-error', null);
        api('/authorizations/' + encodeURIComponent(id) + '/capture', { method: 'POST', key: randomKey(), body: { amount: amount } })
          .then(function (result) {
            if (!result.ok) setMessage('authorizations-messages', 'authorization-error', messageOf(result, 'The capture was refused.'));
            return Promise.all([refreshAuthorizations(), refreshWallet()]);
          }, function () {
            setMessage('authorizations-messages', 'authorization-error', 'We did not get an answer. Try again.');
          });
      });
    });
    card.querySelectorAll('[data-testid^="authorization-void-"]').forEach(function (button) {
      button.addEventListener('click', function () {
        var id = button.getAttribute('data-testid').slice('authorization-void-'.length);
        setMessage('authorizations-messages', 'authorization-error', null);
        api('/authorizations/' + encodeURIComponent(id) + '/void', { method: 'POST' }).then(function (result) {
          if (!result.ok) setMessage('authorizations-messages', 'authorization-error', messageOf(result, 'The hold could not be released.'));
          return Promise.all([refreshAuthorizations(), refreshWallet()]);
        }, function () {
          setMessage('authorizations-messages', 'authorization-error', 'We did not get an answer. Try again.');
        });
      });
    });
  }

  // ---- authentication ---------------------------------------------------

  function submitAuth(path) {
    var payload = { email: value(page === 'signup' ? 'signup-email' : 'login-email') };
    var password = value(page === 'signup' ? 'signup-password' : 'login-password');
    if (page === 'signup') payload.display_name = value('signup-display-name');
    if (payload.email === '') { setMessage('auth-messages', 'auth-error', 'Enter your email address.'); return; }
    if (password === '') { setMessage('auth-messages', 'auth-error', 'Enter your password.'); return; }
    if (page === 'signup' && payload.display_name === '') { setMessage('auth-messages', 'auth-error', 'Enter your name.'); return; }
    payload.password = password;
    setMessage('auth-messages', 'auth-error', null);
    api(path, { method: 'POST', body: payload }).then(function (result) {
      if (!result.ok || !result.json || !result.json.token) {
        setMessage('auth-messages', 'auth-error', messageOf(result, 'That did not work. Check your details.'));
        return;
      }
      try { window.localStorage.setItem('pocketful_token', result.json.token); } catch (error) { /* private mode */ }
      window.location.href = '/';
    }, function () {
      setMessage('auth-messages', 'auth-error', 'We could not reach the service. Try again.');
    });
  }

  function logout() {
    api('/auth/logout', { method: 'POST' }).then(function () {
      try { window.localStorage.removeItem('pocketful_token'); } catch (error) { /* private mode */ }
      window.location.href = '/login';
    }, function () {
      try { window.localStorage.removeItem('pocketful_token'); } catch (error) { /* private mode */ }
      window.location.href = '/login';
    });
  }
  // ---- wiring -----------------------------------------------------------

  var refocus = document.getElementById('wallet-refresh');
  if (refocus) refocus.addEventListener('click', function () { refreshWallet(); });

  var payForm = document.getElementById('pay-form');
  if (payForm) payForm.addEventListener('submit', function (event) { event.preventDefault(); submitPayment(); });

  var requestForm = document.getElementById('request-form');
  if (requestForm) requestForm.addEventListener('submit', function (event) { event.preventDefault(); submitRequest(); });

  var splitAmount = document.querySelector('[data-testid="split-amount"]');
  if (splitAmount) {
    ['split-amount', 'split-handles'].forEach(function (id) {
      var element = document.querySelector('[data-testid="' + id + '"]');
      if (element) element.addEventListener('input', renderPreview);
    });
    renderPreview();
  }
  var splitForm = document.getElementById('split-form');
  if (splitForm) splitForm.addEventListener('submit', function (event) { event.preventDefault(); submitSplit(); });

  var authorizeForm = document.getElementById('authorize-form');
  if (authorizeForm) authorizeForm.addEventListener('submit', function (event) { event.preventDefault(); submitAuthorization(); });

  var loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', function (event) { event.preventDefault(); submitAuth('/auth/login'); });
  var signupForm = document.getElementById('signup-form');
  if (signupForm) signupForm.addEventListener('submit', function (event) { event.preventDefault(); submitAuth('/auth/signup'); });

  var logoutButton = document.querySelector('[data-testid="logout-button"]');
  if (logoutButton) logoutButton.addEventListener('click', logout);

  wireRequestButtons();
  wireAuthorizationButtons();

  if (!token && SIGNED_IN_PAGES.indexOf(page) !== -1) {
    window.location.href = '/login';
  }
}());
