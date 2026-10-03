'use strict';

// Shared rendering helpers. The server uses them for the first paint and the
// browser script uses them for in-place refreshes, so the markup is identical
// whichever side produced it. Pure functions only: no DOM, no network.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PocketfulViews = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    var text = value === undefined || value === null ? '' : String(value);
    return text.replace(/[&<>"']/g, function (character) { return ESCAPES[character]; });
  }

  // Exact decimal string for an integer count of minor units.
  function formatMinor(amount, minorUnits) {
    var value = Number(amount);
    if (!isFinite(value)) return '0';
    var negative = value < 0;
    var absolute = Math.abs(Math.trunc(value));
    if (minorUnits === 0) return (negative ? '-' : '') + String(absolute);
    var scale = Math.pow(10, minorUnits);
    var whole = Math.floor(absolute / scale);
    var fraction = absolute - whole * scale;
    var text = String(whole) + '.' + String(fraction).padStart(minorUnits, '0');
    return (negative ? '-' : '') + text;
  }

  function formatAmount(amount, minorUnits, currency) {
    return formatMinor(amount, minorUnits) + ' ' + currency;
  }

  // A decimal amount as a person types it. Returns null when it is not a
  // number, is negative, or carries more decimal places than the currency has.
  function parseDecimal(text, minorUnits) {
    var trimmed = String(text === undefined || text === null ? '' : text).trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return null;
    var pieces = trimmed.split('.');
    var fraction = pieces.length > 1 ? pieces[1] : '';
    if (fraction.length > minorUnits) return null;
    var scale = Math.pow(10, minorUnits);
    var minor = Number(pieces[0]) * scale + (minorUnits === 0 ? 0 : Number(fraction.padEnd(minorUnits, '0')));
    return Number.isSafeInteger(minor) ? minor : null;
  }

  // The stage 1 split rule: whole minor units, the larger shares going to the
  // first participants, so the shares always sum exactly to the amount.
  function computeShares(amount, count) {
    var shares = [];
    if (!Number.isInteger(amount) || count < 1) return shares;
    var base = Math.floor(amount / count);
    var remainder = amount - base * count;
    for (var index = 0; index < count; index += 1) shares.push(base + (index < remainder ? 1 : 0));
    return shares;
  }

  function formatTimestamp(value) {
    var stamp = Date.parse(value);
    if (Number.isNaN(stamp)) return String(value === undefined || value === null ? '' : value);
    return new Date(stamp).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function money(amount, minorUnits, currency) {
    return '<span class="money">' + esc(formatAmount(amount, minorUnits, currency)) + '</span>';
  }

  // Available is the headline number: it is what the user can actually spend.
  function walletHtml(wallet, minorUnits, currency) {
    var parts = [];
    parts.push('<div class="wallet-available">');
    parts.push('<span class="wallet-label">Available</span>');
    parts.push('<span class="wallet-value" data-testid="wallet-available" data-amount="' + esc(wallet.available) + '">' + esc(formatAmount(wallet.available, minorUnits, currency)) + '</span>');
    parts.push('<span class="wallet-hint">Funds you can spend now</span>');
    parts.push('</div>');
    parts.push('<div class="wallet-secondary">');
    parts.push('<div class="wallet-cell"><span class="wallet-label">Total</span>');
    parts.push('<span class="wallet-value" data-testid="wallet-balance" data-amount="' + esc(wallet.balance) + '">' + esc(formatAmount(wallet.balance, minorUnits, currency)) + '</span><span class="wallet-hint">Total including any held funds</span></div>');
    if (Number(wallet.held) !== 0) {
      parts.push('<div class="wallet-cell"><span class="wallet-label">On hold</span>');
      parts.push('<span class="wallet-value" data-testid="wallet-held" data-amount="' + esc(wallet.held) + '">' + esc(formatAmount(wallet.held, minorUnits, currency)) + '</span></div>');
    }
    parts.push('</div>');
    return parts.join('');
  }

  function activityHtml(payments, minorUnits, currency) {
    if (payments.length === 0) return '<p class="empty" data-testid="empty-activity">No payments yet.</p>';
    var items = payments.map(function (payment) {
      var parts = [];
      parts.push('<article class="activity-item" data-testid="activity-item-' + esc(payment.payment_id) + '" data-visibility="' + esc(payment.visibility) + '">');
      parts.push('<div class="activity-line">');
      parts.push('<span class="activity-parties" data-testid="activity-parties-' + esc(payment.payment_id) + '">' + esc(payment.from_handle) + ' &rarr; ' + esc(payment.to_handle) + '</span>');
      parts.push('<span class="activity-amount" data-testid="activity-amount-' + esc(payment.payment_id) + '">' + esc(formatAmount(payment.amount, minorUnits, currency)) + '</span>');
      parts.push('</div>');
      parts.push('<div class="activity-note" data-testid="activity-note-' + esc(payment.payment_id) + '">' + esc(payment.note) + '</div>');
      parts.push('<div class="activity-meta"><time datetime="' + esc(payment.created_at) + '">' + esc(formatTimestamp(payment.created_at)) + '</time>');
      parts.push('<span class="chip chip-' + esc(payment.visibility) + '">' + esc(payment.visibility) + '</span></div>');
      parts.push('</article>');
      return parts.join('');
    });
    return '<div class="activity-list" data-testid="activity-list">' + items.join('') + '</div>';
  }

  function requestHtml(request, direction, minorUnits, currency) {
    var parts = [];
    var pending = request.status === 'pending';
    parts.push('<article class="request-item" data-testid="request-item-' + esc(request.request_id) + '" data-status="' + esc(request.status) + '">');
    parts.push('<div class="request-line">');
    parts.push('<span class="request-parties">' + esc(request.requester_handle) + ' &rarr; ' + esc(request.payer_handle) + '</span>');
    parts.push('<span class="request-amount" data-testid="request-amount-' + esc(request.request_id) + '">' + esc(formatAmount(request.amount, minorUnits, currency)) + '</span>');
    parts.push('</div>');
    if (request.note !== '') parts.push('<div class="request-note">' + esc(request.note) + '</div>');
    parts.push('<div class="request-meta"><span class="chip chip-' + esc(request.status) + '">' + esc(request.status) + '</span>');
    parts.push('<time datetime="' + esc(request.created_at) + '">' + esc(formatTimestamp(request.created_at)) + '</time></div>');
    parts.push('<div class="request-actions" data-direction="' + esc(direction) + '">');
    if (direction === 'incoming' && pending) {
      parts.push('<button type="button" class="button" data-testid="request-pay-' + esc(request.request_id) + '">Pay</button>');
      parts.push('<button type="button" class="button button-quiet" data-testid="request-decline-' + esc(request.request_id) + '">Decline</button>');
    }
    if (direction === 'outgoing' && pending) {
      parts.push('<button type="button" class="button button-quiet" data-testid="request-cancel-' + esc(request.request_id) + '">Cancel</button>');
    }
    parts.push('</div></article>');
    return parts.join('');
  }

  function requestsHtml(requests, handle, minorUnits, currency) {
    var incoming = [];
    var outgoing = [];
    requests.forEach(function (request) {
      if (request.payer_handle === handle) incoming.push(requestHtml(request, 'incoming', minorUnits, currency));
      else outgoing.push(requestHtml(request, 'outgoing', minorUnits, currency));
    });
    // Both containers are always present; the empty state sits above them so a
    // test can look for either the lists or the empty marker.
    var sections = [];
    if (incoming.length === 0 && outgoing.length === 0) {
      sections.push('<p class="empty" data-testid="empty-requests">No requests yet.</p>');
    }
    sections.push('<section class="panel"><h3>Incoming</h3><div class="request-list" data-testid="incoming-list">',
      incoming.length === 0 ? '<p class="empty">Nothing waiting on you.</p>' : incoming.join(''),
      '</div></section>');
    sections.push('<section class="panel"><h3>Outgoing</h3><div class="request-list" data-testid="outgoing-list">',
      outgoing.length === 0 ? '<p class="empty">Nothing requested.</p>' : outgoing.join(''),
      '</div></section>');
    return sections.join('');
  }

  function authorizationHtml(authorization, handle, minorUnits, currency) {
    var outgoing = authorization.from_handle === handle;
    var open = authorization.status === 'open';
    var parts = [];
    parts.push('<article class="authorization-item" data-testid="authorization-item-' + esc(authorization.authorization_id) + '" data-status="' + esc(authorization.status) + '">');
    parts.push('<div class="authorization-line">');
    parts.push('<span class="authorization-parties">' + esc(authorization.from_handle) + ' &rarr; ' + esc(authorization.to_handle) + '</span>');
    parts.push('<span class="authorization-amount" data-testid="authorization-amount-' + esc(authorization.authorization_id) + '">' + esc(formatAmount(authorization.amount, minorUnits, currency)) + '</span>');
    parts.push('</div>');
    if (authorization.status === 'captured') {
      parts.push('<div class="authorization-captured" data-testid="authorization-captured-' + esc(authorization.authorization_id) + '">' + esc(formatAmount(authorization.captured_amount, minorUnits, currency)) + '</div>');
    }
    parts.push('<div class="authorization-meta"><span class="chip chip-' + esc(authorization.status) + '">' + esc(authorization.status) + '</span>');
    parts.push('<span class="authorization-expires" data-testid="authorization-expires-' + esc(authorization.authorization_id) + '">' + esc(authorization.expires_at) + '</span></div>');
    if (authorization.note !== '') parts.push('<div class="authorization-note">' + esc(authorization.note) + '</div>');
    if (outgoing && open) {
      parts.push('<div class="authorization-actions"><button type="button" class="button button-quiet" data-testid="authorization-void-' + esc(authorization.authorization_id) + '">Release hold</button></div>');
    }
    if (!outgoing && open) {
      parts.push('<div class="authorization-actions">');
      parts.push('<label class="field-inline"><span>Capture</span><input type="text" inputmode="decimal" class="input" data-testid="authorization-capture-amount-' + esc(authorization.authorization_id) + '" value="' + esc(formatMinor(authorization.remaining_amount, minorUnits)) + '"></label>');
      parts.push('<button type="button" class="button" data-testid="authorization-capture-' + esc(authorization.authorization_id) + '">Capture</button>');
      parts.push('</div>');
    }
    parts.push('</article>');
    return parts.join('');
  }

  function authorizationsHtml(authorizations, handle, minorUnits, currency) {
    if (authorizations.length === 0) {
      return '<p class="empty" data-testid="empty-authorizations">No authorizations yet.</p>';
    }
    var items = authorizations.map(function (authorization) {
      return authorizationHtml(authorization, handle, minorUnits, currency);
    });
    return '<div class="authorization-list" data-testid="authorization-list">' + items.join('') + '</div>';
  }

  function splitPreviewHtml(shares, minorUnits, currency) {
    if (shares.length === 0) return '';
    var items = shares.map(function (share) {
      return '<li class="split-share" data-testid="split-share-' + esc(share.handle) + '">' + esc(formatAmount(share.amount, minorUnits, currency)) + '</li>';
    });
    return '<ul class="split-preview-list">' + items.join('') + '</ul>';
  }

  return {
    esc: esc,
    formatMinor: formatMinor,
    formatAmount: formatAmount,
    parseDecimal: parseDecimal,
    computeShares: computeShares,
    formatTimestamp: formatTimestamp,
    walletHtml: walletHtml,
    activityHtml: activityHtml,
    requestsHtml: requestsHtml,
    authorizationsHtml: authorizationsHtml,
    authorizationHtml: authorizationHtml,
    splitPreviewHtml: splitPreviewHtml,
  };
});
