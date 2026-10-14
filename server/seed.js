/**
 * Rally demo seed — runs once when the database has no hosts (fresh deploy).
 *
 * DEMO DATA ONLY: the host credentials below are fake demo creds
 * (username 'demo' / password 'demo1234'), the guest names are invented,
 * and every payment method detail is mocked ('•••• 4242', '@handles').
 * Nothing here is a real person or a real payment instrument.
 *
 * Creates one host + one event "Rooftop Golden Hour" with 6 pledges totaling
 * 14 spots — below the 20-person threshold, so the demo opens in the
 * 'open' state. Dates are relative to now so the demo never looks expired.
 */
'use strict';

const db = require('./db');
const auth = require('./auth');

async function seed() {
  const hostCount = db.prepare('SELECT COUNT(*) AS c FROM hosts').get().c;
  if (hostCount > 0) return; // never overwrite real data

  const passwordHash = await auth.hashPassword('demo1234');
  const host = db.prepare(`INSERT INTO hosts (username, password_hash) VALUES (?, ?)`)
    .run('demo', passwordHash);

  const now = Date.now();
  const DAY = 86400000;
  const eventDate = new Date(now + 30 * DAY).toISOString().slice(0, 10); // YYYY-MM-DD
  const deadline = new Date(now + 14 * DAY).toISOString();

  // Fixed, memorable invite code for the demo event (matches the landing page link).
  const inviteCode = 'DEMO0000';

  const event = db.prepare(`
    INSERT INTO events
      (host_id, title, description, event_date, venue, per_head,
       min_threshold, max_capacity, deadline, invite_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    host.lastInsertRowid,
    'Rooftop Golden Hour',
    'Drinks, skyline views, and small plates to kick off the summer. Bring a friend — pledges are only charged if enough of us commit.',
    eventDate,
    'The Smith Rooftop, Atlanta',
    75,
    20,
    60,
    deadline,
    inviteCode
  );
  const eventId = event.lastInsertRowid;

  // Fake guests, fake methods, fake details. 14 spots total < 20 threshold.
  const demoPledges = [
    ['Maya',   3, 'card',    '•••• 4242'],
    ['Chris',  2, 'venmo',   '@chris-atl'],
    ['Priya',  2, 'cashapp', '$priya-p'],
    ['Sam',    3, 'card',    '•••• 1881'],
    ['Jordan', 2, 'venmo',   '@jordan-r'],
    ['Alex',   2, 'card',    '•••• 9007'],
  ];
  const insertPledge = db.prepare(`
    INSERT INTO pledges (event_id, guest_name, spots, method, method_detail)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [guestName, spots, method, methodDetail] of demoPledges) {
    insertPledge.run(eventId, guestName, spots, method, methodDetail);
  }

  console.log(`Seeded demo host (demo / demo1234), event "Rooftop Golden Hour", invite code ${inviteCode}`);
}

module.exports = seed;
