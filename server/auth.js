/**
 * Auth — token sessions stored in SQLite (survive restarts).
 *
 * Single role: 'host'. The session token lives in an httpOnly cookie
 * named 'rally_session'. Set COOKIE_SECURE=1 in production (HTTPS).
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./db');

const COOKIE_NAME = 'rally_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession({ hostId }) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, host_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, hostId, expiresAt);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

/** Attach req.session (or null) from the cookie. */
function sessionMiddleware(req, res, next) {
  req.session = getSession(req.cookies[COOKIE_NAME]);
  next();
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    // secure: true in production behind HTTPS (set via env)
    secure: process.env.COOKIE_SECURE === '1',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

/**
 * Require a signed-in host. Also attaches req.hostUser = { id, username };
 * a 404-safe lookup means sessions for deleted hosts behave as signed out.
 */
function requireHost(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Host sign-in required' });
  const host = db.prepare(`SELECT id, username FROM hosts WHERE id = ?`).get(req.session.host_id);
  if (!host) {
    destroySession(req.session.token);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Host sign-in required' });
  }
  req.hostUser = host;
  next();
}

/** Optional host (for /api/me): never rejects, attaches req.hostUser or null. */
function optionalHost(req, res, next) {
  req.hostUser = null;
  if (req.session) {
    req.hostUser = db.prepare(`SELECT id, username FROM hosts WHERE id = ?`).get(req.session.host_id) || null;
  }
  next();
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  COOKIE_NAME,
  createSession,
  getSession,
  destroySession,
  sessionMiddleware,
  setSessionCookie,
  clearSessionCookie,
  requireHost,
  optionalHost,
  hashPassword,
  verifyPassword,
};
