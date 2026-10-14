/**
 * Rally — production backend.
 *
 *  HTTP  REST API under /api  (see routes.js)
 *  WS    Live push on the same port: clients receive
 *        { type: 'event_updated', invite_code, event_id, status, committed_spots }
 *        and re-fetch the read models.
 *
 *  Guests open /r/:invite_code to view/pledge on an event (invite.html,
 *  built by the frontend agent). Hosts use the dashboard at / (index.html).
 *
 * Run:  node server/index.js   (PORT env overrides, default 3000)
 *       Do NOT start the server during backend verification — the parent
 *       agent will test it separately.
 */
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

require('./db'); // ensure schema exists
const db = require('./db');

// Auto-seed on first boot when the database is empty (e.g. fresh Render
// deploy with a new persistent disk). Safe: seed.js returns immediately
// once any host exists, and this only runs when no hosts exist at all.
try {
  const count = db.prepare('SELECT COUNT(*) AS c FROM hosts').get().c;
  if (count === 0) {
    console.log('Empty database detected — seeding Rally demo data...');
    require('./seed')().then(
      () => console.log('Auto-seed complete.'),
      (e) => console.error('Auto-seed failed:', e)
    );
  }
} catch (e) {
  console.error('Auto-seed check failed:', e.message);
}

const auth = require('./auth');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.sessionMiddleware);

// ------------------------------------------------------------- live bus
const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
// Routes push updates through here (e.g. after a pledge or confirm).
app.locals.broadcast = broadcast;

// ------------------------------------------------------------------ API
app.use('/api', routes);

// --------------------------------------------------------------- static
// Frontend lives in public/ (built by the frontend agent). Until then,
// the health endpoint and JSON fallbacks keep the service inspectable.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Guest invite link: /r/:code -> public/invite.html (frontend agent builds it).
app.get('/r/:code', (req, res, next) => {
  const file = path.join(__dirname, '..', 'public', 'invite.html');
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'Invite page not built yet' });
  }
  res.sendFile(file);
});

// Host dashboard: / -> public/index.html (frontend agent builds it).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) res.json({ ok: true, service: 'rally-live', api: '/api/health' });
  });
});

// ------------------------------------------------------------------ boot
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  // Immediately orient the client; it then fetches REST read models.
  ws.send(JSON.stringify({ type: 'connected', clients: wsClients.size }));
});

server.listen(PORT, () => {
  console.log(`Rally live server on http://localhost:${PORT}`);
  console.log(`WebSocket live sync ready (${wsClients.size} clients).`);
});
