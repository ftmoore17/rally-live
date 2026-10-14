# Rally — Reference

**Rally** is a threshold-based group event funding platform. Hosts create events
("Rally Calls") with a per-head cost and a minimum commitment threshold. Guests
make **conditional pledges** through a public invite link. Pledges are only
"charged" — **simulated, never real** — when the threshold is met and the host
confirms the event. There is no Stripe integration and no real charge code path
anywhere in this codebase, by design.

- Stack: Node.js + Express 5 + better-sqlite3 + bcrypt + cookie-parser + ws.
  Vanilla HTML/CSS/JS frontend, no build step. Mobile-first (base 390px).
- Live: n/a (not yet deployed). Service name for Render: `rally-live`.
- Run locally: `npm install && npm start` → http://localhost:3000
- Demo: host `demo` / `demo1234`, invite link `/r/DEMO0000` (seeded on first boot).

## Data model (SQLite, `data/rally.db`)

- **hosts**(id, username UNIQUE, password_hash, created_at) — bcrypt-hashed logins.
- **sessions**(token PK, host_id → hosts, expires_at) — 14-day token sessions.
- **events**(id, host_id → hosts, title, description, event_date YYYY-MM-DD,
  venue, per_head INT dollars 1–9999, min_threshold INT 1–9999,
  max_capacity INT ≥ min_threshold ≤ 9999, deadline ISO datetime,
  invite_code TEXT UNIQUE 8 chars, status, created_at)
  - status: `open` → `threshold_met` (auto when committed spots ≥ min_threshold)
    → `confirmed` (host clicks confirm) · `expired` (deadline passed while open,
    lazy) · `cancelled` (host cancels while open/threshold_met)
- **pledges**(id, event_id → events, guest_name COLLATE NOCASE,
  spots INT, method `card|venmo|cashapp`, method_detail (mock last-4/handle),
  status `pending|charged_simulated|released`, created_at,
  UNIQUE(event_id, guest_name))
  - One row per guest name per event; repeat commits accumulate spots.
  - `committed_spots` = SUM(spots) WHERE status IN (`pending`,`charged_simulated`).

## API routes

Auth (no login): `POST /api/hosts/register`, `POST /api/hosts/login`,
`POST /api/hosts/logout`, `GET /api/me`, `GET /api/health`.

Host (session cookie): `GET /api/events`, `POST /api/events`,
`GET /api/events/:id`, `PUT /api/events/:id` (only when `open`),
`POST /api/events/:id/confirm` (only when `threshold_met` → pledges become
`charged_simulated`), `POST /api/events/:id/cancel` (`open`/`threshold_met` →
pledges `released`).

Public: `GET /api/public/events/:code` (event + pledge wall; lazily expires past
deadline), `POST /api/public/events/:code/pledge`
`{guest_name, spots 1–5, method, method_detail}` — validates open status,
deadline, capacity (409); upserts by guest name; auto-flips to `threshold_met`;
broadcasts `{type:'event_updated', invite_code, event_id, status,
committed_spots}` over WebSocket (same port, `app.locals.broadcast`).

Invite-link format: `/r/:code` → serves `public/invite.html`, which reads the
code from the path.

## Pages (`public/`)

`index.html` (landing) · `login.html` (host login/register, no popups) ·
`dashboard.html` (host's events) · `builder.html` (event form, 4-digit-max
inputs, live economics preview) · `host-event.html?id=` (status, "Send a Rally
Call" invite panel + copy button, pledge table, inline confirm/cancel/edit) ·
`invite.html` (guest view: "A conditional invite", detail grid, live progress,
commit form with simulated Card/Venmo/Cash App, pledge wall). All pages live-
update via WebSocket.

## Deploy (Render)

`render.yaml` defines the `rally-live` web service (Node, Starter plan,
`npm install` → `bash start.sh`, health check `/api/health`, 1 GB persistent
disk mounted at `/opt/render/project/src/data` — the app writes
`data/rally.db` there). No env vars required (payments are simulated).
First boot with an empty DB auto-seeds the demo host + event.

## Test log (2026-10-14, local)

Full flow verified via API: register → login → create event → guest pledges
(2 + 3 same-name accumulation, case-insensitive) → threshold auto-flip at 6/6
→ pledge rejected after `threshold_met` (400) → host confirm → pledges
`charged_simulated`. Also verified: over-capacity 409, unauth 401, duplicate
username 409, lazy expiry on past deadline, WS handshake + live
`event_updated` broadcast received by a connected client, all pages return 200,
guest copy ("A conditional invite", "Commit & choose payment", "Simulated"
badges) present. Bug fixed during testing: `req.host` collided with Express 5's
getter-only request property — renamed to `req.hostUser` in
`server/auth.js` / `server/routes.js`.

Visual check at 390px was not possible in this environment (no browser);
markup uses a mobile-first stylesheet with `viewport` meta and a 520px max
container — verify visually on a phone before calling it done.
