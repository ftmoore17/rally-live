/* ============================================================
   Rally — shared JS helpers
   api(), fmt helpers, escapeHtml, requireHost, wsConnect.
   ============================================================ */
(function () {
  'use strict';

  /** API wrapper: JSON in/out, same-origin credentials.
   *  Throws an Error with the server's message on !ok. */
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, Object.assign(
      { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } },
      opts,
      opts.body !== undefined
        ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }
        : {}
    ));
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /** Escape user-supplied text before injecting into HTML. */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return '$0';
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  /** Parse a YYYY-MM-DD date (or ISO) and format like "Sat, Aug 15". */
  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    // Force local-noon parsing to avoid TZ day-shift on date-only strings
    const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? new Date(dateStr + 'T12:00:00')
      : new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  /** Long date-time for deadlines, e.g. "Aug 15, 2026 · 5:00 PM". */
  function fmtDateTime(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  /** Whole days left until an ISO date/datetime (0 if today/past). */
  function daysLeft(dateStr) {
    if (!dateStr) return 0;
    const target = new Date(dateStr);
    if (isNaN(target)) return 0;
    const now = new Date();
    const ms = target.getTime() - now.getTime();
    return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }

  /** Guest-friendly status labels. */
  var STATUS_LABELS = {
    open: 'Open for commitments',
    threshold_met: 'Threshold met — waiting on the host',
    confirmed: "It's on!",
    expired: 'This Rally Call expired',
    cancelled: 'Cancelled'
  };
  function statusLabel(s) { return STATUS_LABELS[s] || s; }

  /** Redirect to login.html unless a host session exists. Returns host. */
  async function requireHost() {
    let me;
    try { me = await api('/api/me'); }
    catch (e) { me = { host: null }; }
    if (!me || !me.host) {
      location.href = '/login.html';
      // Throw to halt further execution on the current page.
      throw new Error('Not authenticated');
    }
    return me.host;
  }

  /** Open a WebSocket; calls onEventUpdated(payload) for type 'event_updated'.
   *  Silently no-ops if WebSocket is unavailable. Returns the socket. */
  function wsConnect(onEventUpdated) {
    if (!('WebSocket' in window)) return null;
    let ws;
    try {
      ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
    } catch (e) { return null; }
    ws.addEventListener('message', function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === 'event_updated' && typeof onEventUpdated === 'function') {
        onEventUpdated(msg);
      }
    });
    ws.addEventListener('close', function () {
      // Single quiet reconnect attempt after a few seconds.
      setTimeout(function () {
        if (ws.readyState === WebSocket.CLOSED) wsConnect(onEventUpdated);
      }, 5000);
    });
    return ws;
  }

  /** Set .field-error text and toggle .invalid on a field wrapper. */
  function setFieldError(fieldId, msg) {
    var el = document.getElementById(fieldId);
    if (!el) return;
    var err = el.querySelector('.field-error');
    if (msg) {
      el.classList.add('invalid');
      if (err) err.textContent = msg;
    } else {
      el.classList.remove('invalid');
      if (err) err.textContent = '';
    }
  }

  /** Card number: strip non-digits, group in 4s, cap at 16 digits. */
  function formatCardNumber(raw) {
    return raw.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  // Expose globals
  window.Rally = {
    api: api,
    escapeHtml: escapeHtml,
    money: money,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    daysLeft: daysLeft,
    statusLabel: statusLabel,
    requireHost: requireHost,
    wsConnect: wsConnect,
    setFieldError: setFieldError,
    formatCardNumber: formatCardNumber
  };
})();
