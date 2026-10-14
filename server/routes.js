/**
 * Rally — REST API.
 *
 *  POST /api/hosts/register
 *  POST /api/hosts/login
 *  POST /api/hosts/logout
 *  GET  /api/me
 *  GET  /api/health
 *
 *  GET  /api/events            (host)
 *  POST /api/events            (host)
 *  GET  /api/events/:id        (host, own event)
 *  PUT  /api/events/:id        (host, only when open)
 *  POST /api/events/:id/confirm (host, only when threshold_met)
 *  POST /api/events/:id/cancel  (host, when open | threshold_met)
 *
 *  GET  /api/public/events/:code          (guests, lazy expiry)
 *  POST /api/public/events/:code/pledge   (guests)
 *
 * All payments are SIMULATED — there is no real charge code path anywhere
 * in this file ('charged_simulated' is a status flag, not a transaction).
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');

const router = express.Router();

// ---------------------------------------------------------------- helpers

const PLEDGE_METHODS = ['card', 'venmo', 'cashapp'];
const COUNTED_PLEDGE_STATUSES = ['pending', 'charged_simulated'];

// Invite codes: 8 chars from an unambiguous alphabet (no vowels, no 0/1/O/I).
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

function generateInviteCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!db.prepare(`SELECT 1 FROM events WHERE invite_code = ?`).get(code)) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

/** Total committed spots = SUM(spots) of pledges still counting toward the event. */
function committedSpots(eventId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(spots), 0) AS c FROM pledges
    WHERE event_id = ? AND status IN ('pending', 'charged_simulated')
  `).get(eventId);
  return row.c;
}

/**
 * Lazy expiry: if an 'open' event is past its deadline, flip it to 'expired'
 * and release its pending pledges. Returns the (possibly refreshed) event row.
 */
function refreshEventStatus(event) {
  if (!event || event.status !== 'open') return event;
  if (new Date(event.deadline).getTime() > Date.now()) return event;
  db.prepare(`UPDATE events SET status = 'expired' WHERE id = ?`).run(event.id);
  db.prepare(
    `UPDATE pledges SET status = 'released' WHERE event_id = ? AND status = 'pending'`
  ).run(event.id);
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);
}

/** Push a live update to all connected WS clients. */
function emitEventUpdated(req, event, committed) {
  const broadcast = req.app && req.app.locals && req.app.locals.broadcast;
  if (typeof broadcast === 'function') {
    broadcast({
      type: 'event_updated',
      invite_code: event.invite_code,
      event_id: event.id,
      status: event.status,
      committed_spots: committed,
    });
  }
}

/** Host's own event, or null (also handles lazy expiry). */
function getOwnEvent(req, id) {
  const event = db.prepare(`SELECT * FROM events WHERE id = ? AND host_id = ?`)
    .get(id, req.hostUser.id);
  return event ? refreshEventStatus(event) : null;
}

function isIntInRange(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isFutureIso(s) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) && t > Date.now();
}

/** Validate a full or partial event payload. Returns { ok, error } or { ok, clean }. */
function validateEventInput(body, existing = null) {
  const b = body || {};
  const has = (k) => b[k] !== undefined && b[k] !== null;

  // Title (required on create)
  if (!existing && (!has('title') || String(b.title).trim() === '')) {
    return { ok: false, error: 'title is required' };
  }
  if (has('title') && String(b.title).trim() === '') {
    return { ok: false, error: 'title cannot be empty' };
  }

  // Event date (required on create)
  if (!existing && !has('event_date')) {
    return { ok: false, error: 'event_date is required (YYYY-MM-DD)' };
  }
  if (has('event_date') && !isValidDateString(b.event_date)) {
    return { ok: false, error: 'event_date must be a valid date (YYYY-MM-DD)' };
  }

  // Numbers (required on create). min/per_head/capacity must survive merge for PUT.
  const perHead = has('per_head') ? b.per_head : existing && existing.per_head;
  const minThreshold = has('min_threshold') ? b.min_threshold : existing && existing.min_threshold;
  const maxCapacity = has('max_capacity') ? b.max_capacity : existing && existing.max_capacity;

  if (!existing && !has('per_head')) return { ok: false, error: 'per_head is required (dollars, 1-9999)' };
  if (has('per_head') && !isIntInRange(b.per_head, 1, 9999)) {
    return { ok: false, error: 'per_head must be an integer between 1 and 9999' };
  }
  if (!existing && !has('min_threshold')) return { ok: false, error: 'min_threshold is required (people, 1-9999)' };
  if (has('min_threshold') && !isIntInRange(b.min_threshold, 1, 9999)) {
    return { ok: false, error: 'min_threshold must be an integer between 1 and 9999' };
  }
  if (!existing && !has('max_capacity')) return { ok: false, error: 'max_capacity is required' };
  if (has('max_capacity') && !isIntInRange(b.max_capacity, 1, 9999)) {
    return { ok: false, error: 'max_capacity must be an integer between 1 and 9999' };
  }
  if (perHead !== undefined && minThreshold !== undefined && maxCapacity !== undefined) {
    if (maxCapacity < minThreshold) {
      return { ok: false, error: 'max_capacity must be >= min_threshold' };
    }
  }

  // Deadline (required on create, must be in the future)
  if (!existing && !has('deadline')) {
    return { ok: false, error: 'deadline is required (ISO datetime, must be in the future)' };
  }
  if (has('deadline') && !isFutureIso(b.deadline)) {
    return { ok: false, error: 'deadline must be a valid ISO datetime in the future' };
  }

  // Build the cleaned row fragment for INSERT/UPDATE.
  const clean = {};
  if (has('title')) clean.title = String(b.title).trim();
  if (has('description')) clean.description = String(b.description);
  if (has('event_date')) clean.event_date = b.event_date;
  if (has('venue')) clean.venue = String(b.venue);
  if (has('per_head')) clean.per_head = b.per_head;
  if (has('min_threshold')) clean.min_threshold = b.min_threshold;
  if (has('max_capacity')) clean.max_capacity = b.max_capacity;
  if (has('deadline')) clean.deadline = new Date(b.deadline).toISOString();

  return { ok: true, clean };
}

function eventWithCounts(event) {
  return { ...event, committed_spots: committedSpots(event.id) };
}

// ------------------------------------------------------------------ health

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'rally-live' });
});

// -------------------------------------------------------------- host auth

router.post('/hosts/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 30) {
    return res.status(400).json({ error: 'username must be 3-30 characters' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const name = username.trim();
  if (db.prepare(`SELECT 1 FROM hosts WHERE username = ?`).get(name)) {
    return res.status(409).json({ error: 'Username is taken' });
  }
  const hash = await auth.hashPassword(password);
  const info = db.prepare(`INSERT INTO hosts (username, password_hash) VALUES (?, ?)`)
    .run(name, hash);
  const token = auth.createSession({ hostId: info.lastInsertRowid });
  auth.setSessionCookie(res, token);
  res.status(201).json({ ok: true, host: { id: info.lastInsertRowid, username: name } });
});

router.post('/hosts/login', async (req, res) => {
  const { username, password } = req.body || {};
  const host = typeof username === 'string'
    ? db.prepare(`SELECT * FROM hosts WHERE username = ?`).get(username.trim())
    : null;
  const valid = host && typeof password === 'string' && await auth.verifyPassword(password, host.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
  const token = auth.createSession({ hostId: host.id });
  auth.setSessionCookie(res, token);
  res.json({ ok: true, host: { id: host.id, username: host.username } });
});

router.post('/hosts/logout', (req, res) => {
  auth.destroySession(req.cookies[auth.COOKIE_NAME]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.optionalHost, (req, res) => {
  res.json({ host: req.hostUser });
});

// ------------------------------------------------------------- host events

const EVENT_LIST_COLS = 'id, title, event_date, venue, status, invite_code, per_head, min_threshold, max_capacity, deadline, created_at';

router.get('/events', auth.requireHost, (req, res) => {
  const rows = db.prepare(`
    SELECT ${EVENT_LIST_COLS} FROM events
    WHERE host_id = ? ORDER BY created_at DESC, id DESC
  `).all(req.hostUser.id);
  res.json({ events: rows.map((e) => eventWithCounts(refreshEventStatus(e))) });
});

router.post('/events', auth.requireHost, (req, res) => {
  const v = validateEventInput(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const c = v.clean;
  const info = db.prepare(`
    INSERT INTO events
      (host_id, title, description, event_date, venue, per_head, min_threshold,
       max_capacity, deadline, invite_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.hostUser.id,
    c.title,
    c.description || '',
    c.event_date,
    c.venue || '',
    c.per_head,
    c.min_threshold,
    c.max_capacity,
    c.deadline,
    generateInviteCode()
  );
  const event = db.prepare(`SELECT * FROM events WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ event: eventWithCounts(event) });
});

router.get('/events/:id', auth.requireHost, (req, res) => {
  const event = getOwnEvent(req, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const pledges = db.prepare(`
    SELECT id, guest_name, spots, method, method_detail, status, created_at
    FROM pledges WHERE event_id = ? ORDER BY created_at
  `).all(event.id);
  res.json({ event: eventWithCounts(event), pledges, committed_spots: committedSpots(event.id) });
});

router.put('/events/:id', auth.requireHost, (req, res) => {
  const event = getOwnEvent(req, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'open') {
    return res.status(400).json({ error: 'Only open events can be edited' });
  }
  const v = validateEventInput(req.body, event);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const keys = Object.keys(v.clean);
  if (keys.length === 0) return res.json({ event: eventWithCounts(event) });

  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE events SET ${setSql} WHERE id = ?`).run(
    ...keys.map((k) => v.clean[k]),
    event.id
  );

  let updated = db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);

  // If the edit lowered the threshold below what's already committed, flip it.
  const committed = committedSpots(updated.id);
  if (updated.status === 'open' && committed >= updated.min_threshold) {
    db.prepare(`UPDATE events SET status = 'threshold_met' WHERE id = ?`).run(updated.id);
    updated = db.prepare(`SELECT * FROM events WHERE id = ?`).get(updated.id);
  }

  emitEventUpdated(req, updated, committed);
  res.json({ event: eventWithCounts(updated) });
});

router.post('/events/:id/confirm', auth.requireHost, (req, res) => {
  const event = getOwnEvent(req, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'threshold_met') {
    return res.status(400).json({ error: 'Only events that met their threshold can be confirmed' });
  }
  // SIMULATED capture: flip pledge flags; no real charge code path exists.
  db.transaction(() => {
    db.prepare(`UPDATE events SET status = 'confirmed' WHERE id = ?`).run(event.id);
    db.prepare(
      `UPDATE pledges SET status = 'charged_simulated'
       WHERE event_id = ? AND status = 'pending'`
    ).run(event.id);
  })();
  const updated = db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);
  const committed = committedSpots(updated.id);
  emitEventUpdated(req, updated, committed);
  res.json({ event: eventWithCounts(updated) });
});

router.post('/events/:id/cancel', auth.requireHost, (req, res) => {
  const event = getOwnEvent(req, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status !== 'open' && event.status !== 'threshold_met') {
    return res.status(400).json({ error: 'Only open or threshold-met events can be cancelled' });
  }
  db.transaction(() => {
    db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = ?`).run(event.id);
    db.prepare(
      `UPDATE pledges SET status = 'released'
       WHERE event_id = ? AND status = 'pending'`
    ).run(event.id);
  })();
  const updated = db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);
  const committed = committedSpots(updated.id);
  emitEventUpdated(req, updated, committed);
  res.json({ event: eventWithCounts(updated) });
});

// ------------------------------------------------------------ public guest

router.get('/public/events/:code', (req, res) => {
  let event = db.prepare(`SELECT * FROM events WHERE invite_code = ?`).get(req.params.code);
  if (!event) return res.status(404).json({ error: 'Unknown invite code' });
  // Lazy expiry: past-deadline open events expire on read.
  event = refreshEventStatus(event);

  const committed = committedSpots(event.id);
  const pledges = db.prepare(`
    SELECT guest_name, spots FROM pledges
    WHERE event_id = ? AND status IN ('pending', 'charged_simulated')
    ORDER BY created_at
  `).all(event.id);
  const daysLeft = Math.max(0, Math.ceil((new Date(event.deadline).getTime() - Date.now()) / 86400000));

  res.json({
    event: {
      title: event.title,
      description: event.description,
      event_date: event.event_date,
      venue: event.venue,
      per_head: event.per_head,
      min_threshold: event.min_threshold,
      max_capacity: event.max_capacity,
      deadline: event.deadline,
      invite_code: event.invite_code,
      status: event.status,
      committed_spots: committed,
      spots_remaining: event.max_capacity - committed,
      days_left: daysLeft,
    },
    pledges,
  });
});

router.post('/public/events/:code/pledge', (req, res) => {
  let event = db.prepare(`SELECT * FROM events WHERE invite_code = ?`).get(req.params.code);
  if (!event) return res.status(404).json({ error: 'Unknown invite code' });
  // Lazy expiry before validating the pledge.
  event = refreshEventStatus(event);

  if (event.status !== 'open') {
    const gone = event.status === 'expired' || event.status === 'cancelled' || event.status === 'confirmed';
    return res.status(gone ? 410 : 400).json({ error: `This event is ${event.status} and no longer accepting pledges` });
  }

  const body = req.body || {};
  const guestName = typeof body.guest_name === 'string' ? body.guest_name.trim() : '';
  if (guestName.length < 1 || guestName.length > 40) {
    return res.status(400).json({ error: 'guest_name is required (1-40 characters)' });
  }
  const spots = body.spots;
  if (!isIntInRange(spots, 1, 5)) {
    return res.status(400).json({ error: 'spots must be an integer between 1 and 5' });
  }
  if (!PLEDGE_METHODS.includes(body.method)) {
    return res.status(400).json({ error: 'method must be one of: card, venmo, cashapp' });
  }
  const methodDetail = typeof body.method_detail === 'string' ? body.method_detail.slice(0, 80) : '';

  const committed = committedSpots(event.id);
  if (committed + spots > event.max_capacity) {
    return res.status(409).json({ error: 'This event is at capacity' });
  }

  // Upsert on (event_id, guest_name): repeat pledges from the same guest
  // (case-insensitive) accumulate spots and keep the ORIGINAL method.
  const upsert = db.transaction(() => {
    const existing = db.prepare(
      `SELECT * FROM pledges WHERE event_id = ? AND guest_name = ?`
    ).get(event.id, guestName);

    let pledge;
    if (existing) {
      db.prepare(`UPDATE pledges SET spots = spots + ? WHERE id = ?`).run(spots, existing.id);
      pledge = db.prepare(`SELECT * FROM pledges WHERE id = ?`).get(existing.id);
    } else {
      const info = db.prepare(`
        INSERT INTO pledges (event_id, guest_name, spots, method, method_detail)
        VALUES (?, ?, ?, ?, ?)
      `).run(event.id, guestName, spots, body.method, methodDetail);
      pledge = db.prepare(`SELECT * FROM pledges WHERE id = ?`).get(info.lastInsertRowid);
    }

    const newCommitted = committedSpots(event.id);
    let status = event.status;
    if (newCommitted >= event.min_threshold && event.status === 'open') {
      db.prepare(`UPDATE events SET status = 'threshold_met' WHERE id = ?`).run(event.id);
      status = 'threshold_met';
    }
    return { pledge, committed: newCommitted, status };
  });
  const result = upsert();

  const updatedEvent = db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);
  emitEventUpdated(req, updatedEvent, result.committed);

  res.json({ pledge: result.pledge, committed_spots: result.committed, status: result.status });
});

module.exports = router;
