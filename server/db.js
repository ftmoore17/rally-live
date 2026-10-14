/**
 * Rally — database layer (SQLite via better-sqlite3).
 *
 * Single-file database (data/rally.db), zero-config. All timestamps are
 * stored as ISO-8601 strings in UTC (ISO datetime strings, e.g.
 * "2026-10-14T17:00:00.000Z").
 *
 * Money is stored as whole dollars (per_head INTEGER, 1–9999).
 * Pledges are SIMULATED only — no real payment processor is ever touched.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'rally.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
-- Host accounts (event organizers). One role: 'host'.
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Token sessions (persistent across restarts, unlike memory stores).
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Group events with a per-head cost and a minimum commitment threshold.
-- Status lifecycle: open -> threshold_met -> confirmed
--                   open -> expired            (deadline passes, lazy)
--                   open | threshold_met -> cancelled
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,                          -- YYYY-MM-DD
  venue TEXT NOT NULL DEFAULT '',
  per_head INTEGER NOT NULL,                         -- dollars, 1-9999
  min_threshold INTEGER NOT NULL,                    -- people, 1-9999
  max_capacity INTEGER NOT NULL,                     -- >= min_threshold, <= 9999
  deadline TEXT NOT NULL,                            -- ISO datetime (UTC)
  invite_code TEXT UNIQUE NOT NULL,                  -- 8 chars, guest-facing
  status TEXT NOT NULL DEFAULT 'open',               -- open | threshold_met | confirmed | expired | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Conditional pledges. SIMULATED payments only — 'charged_simulated'
-- means we flipped a flag at confirm time, not that money moved.
CREATE TABLE IF NOT EXISTS pledges (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL COLLATE NOCASE,
  spots INTEGER NOT NULL DEFAULT 1,
  method TEXT NOT NULL,                              -- card | venmo | cashapp
  method_detail TEXT NOT NULL DEFAULT '',            -- mock last4 like '•••• 4242' or handle
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | charged_simulated | released
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, guest_name)                        -- NOCASE: 'Maya' and 'maya' are the same guest
);
`;

db.exec(SCHEMA);

module.exports = db;
