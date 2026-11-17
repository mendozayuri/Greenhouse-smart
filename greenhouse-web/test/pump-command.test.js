// Round trip of the manual pump command, with an in-memory stand-in for MySQL:
// website button -> queued -> handed to the ESP32 in its upload reply -> acknowledged -> shown on the dashboard.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.JWT_SECRET = 'test-secret';
const jwt = require('jsonwebtoken');

// ---- fake database ----
const db = { lastSeen: Date.now(), cmds: [], assigned: new Set(['1:1']), nextId: 1, activity: [] };
const age = () => Math.floor((Date.now() - db.lastSeen) / 1000);
const settingsRow = { temp_on: 30, temp_off: 28, soil_low: 40, version: 1, acked_version: 0, acked_at: null, updated_at: null };

async function fakeQuery(sql, p = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/FROM users WHERE id/.test(q)) return [[{ id: p[0], email: p[0] === 1 ? 'a@x.com' : 'b@x.com', role: 'user', active: 1 }]];
  if (/FROM assignments WHERE user_id/.test(q)) return [db.assigned.has(`${p[0]}:${p[1]}`) ? [{ 1: 1 }] : []];
  if (/INSERT INTO activity_log/.test(q)) { db.activity.push(p[2]); return [{}]; }   // params: user, device, action, detail
  if (/SELECT id FROM devices WHERE api_key/.test(q)) return [p[0] === 'KEY' ? [{ id: 1 }] : []];
  if (/INSERT INTO readings/.test(q)) return [{}];
  if (/UPDATE devices SET last_seen/.test(q)) { db.lastSeen = Date.now(); return [{}]; }
  if (/UPDATE settings SET acked_version/.test(q)) return [{}];
  if (/INSERT IGNORE INTO settings/.test(q)) return [{}];
  if (/FROM settings WHERE device_id/.test(q)) return [[{ ...settingsRow }]];
  if (/FROM alert_rules/.test(q)) return [[]];
  if (/TIMESTAMPDIFF\(SECOND, last_seen, NOW\(\)\) AS age/.test(q)) return [[{ age: age() }]];
  if (/TIMESTAMPDIFF\(SECOND, d.last_seen/.test(q)) return [[{ id: 1, name: 'GH', last_seen: new Date(db.lastSeen), age_seconds: age() }]];
  if (/FROM readings WHERE device_id = \? ORDER BY/.test(q)) return [[]];
  if (/FROM alerts WHERE device_id/.test(q)) return [[]];
  if (/UPDATE device_commands SET status = 'expired', result = 'Replaced by a newer command'/.test(q)) {
    db.cmds.forEach((c) => { if (['pending', 'sent'].includes(c.status)) { c.status = 'expired'; c.result = 'Replaced by a newer command'; } });
    return [{}];
  }
  if (/UPDATE device_commands SET status = 'expired'/.test(q)) {
    db.cmds.forEach((c) => { if (['pending', 'sent'].includes(c.status) && (Date.now() - c.requested) / 1000 > 60) { c.status = 'expired'; } });
    return [{}];
  }
  if (/FROM device_commands c LEFT JOIN users/.test(q)) {
    const c = db.cmds[db.cmds.length - 1];
    return [c ? [{ id: c.id, action: c.action, status: c.status, result: c.result || null, requested_at: new Date(c.requested), sent_at: null, acked_at: c.acked ? new Date() : null, requested_by: 'a@x.com' }] : []];
  }
  if (/INSERT INTO device_commands/.test(q)) { const c = { id: db.nextId++, action: p[1], status: 'pending', requested: Date.now() }; db.cmds.push(c); return [{ insertId: c.id }]; }
  if (/SELECT id, action FROM device_commands WHERE device_id = \? AND status IN/.test(q)) {
    const c = [...db.cmds].reverse().find((x) => ['pending', 'sent'].includes(x.status)); return [c ? [{ id: c.id, action: c.action }] : []];
  }
  if (/UPDATE device_commands SET status = 'sent'/.test(q)) { db.cmds.find((x) => x.id === p[0]).status = 'sent'; return [{}]; }
  if (/UPDATE device_commands SET status = \?, result = \?/.test(q)) {
    const c = db.cmds.find((x) => x.id === p[2]); if (!c) return [{ affectedRows: 0 }];
    c.status = p[0]; c.result = p[1]; c.acked = true; return [{ affectedRows: 1 }];
  }
  throw new Error('fake db: unhandled query: ' + q.slice(0, 90));
}
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'mysql2/promise') return { createPool: () => ({ query: fakeQuery }), createConnection: async () => ({ query: async () => {}, end: async () => {} }) };
  return origLoad.call(this, req, ...rest);
};
const app = require('../server');

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => { server.close(); Module._load = origLoad; });

const token = (id) => jwt.sign({ id }, 'test-secret');
const call = async (path, { method = 'GET', body, user } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: 'Bearer ' + token(user) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
const upload = (extra = {}) => call('/api/device/readings', { method: 'POST', body: { device_key: 'KEY', temperature: 25, humidity: 60, soil_moisture: 0, state: 'IDLE', fan_on: false, pump_on: false, light_on: false, settings_version: 1, ...extra } });

test('full round trip: queue -> device picks it up -> acknowledged -> visible on dashboard', async () => {
  await upload();                                                    // device is online
  const q = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'on' } });
  assert.equal(q.status, 202);
  assert.equal(q.json.command.status, 'pending');

  const again = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'on' } });
  assert.equal(again.status, 409, 'a second command is refused while one is waiting');

  let ov = await call('/api/my/overview?device_id=1', { user: 1 });
  assert.equal(ov.json.pump_command.status, 'pending');

  const r1 = await upload();                                         // the ESP32's next upload receives the command
  assert.equal(r1.json.pump_command_id, q.json.command.id);
  assert.equal(r1.json.pump_command_on, 1, 'an ON command tells the device to switch the pump on');
  ov = await call('/api/my/overview?device_id=1', { user: 1 });
  assert.equal(ov.json.pump_command.status, 'sent');

  const r2 = await upload({ command_id: q.json.command.id, command_result: 'done' });   // acknowledgement
  assert.equal(r2.json.pump_command_id, undefined, 'an acknowledged command is not sent again');
  ov = await call('/api/my/overview?device_id=1', { user: 1 });
  assert.equal(ov.json.pump_command.status, 'done');
  assert.ok(ov.json.pump_command.acked_at);
  assert.ok(db.activity.includes('pump_command'), 'the request is written to the activity log');
  assert.ok(db.activity.includes('pump_result'), 'the device result is written to the activity log');
});

test('the device can reject a command and the website shows it', async () => {
  const q = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'on' } });
  await upload();
  await upload({ command_id: q.json.command.id, command_result: 'rejected_fault' });
  const ov = await call('/api/my/overview?device_id=1', { user: 1 });
  assert.equal(ov.json.pump_command.status, 'rejected');
  assert.match(ov.json.pump_command.result, /sensor fault/);
});

test('invalid acknowledgement values are ignored', async () => {
  const q = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'on' } });
  await upload({ command_id: q.json.command.id, command_result: 'hacked' });
  const ov = await call('/api/my/overview?device_id=1', { user: 1 });
  assert.ok(['pending', 'sent'].includes(ov.json.pump_command.status), 'still waiting: the bad result was ignored');
  await upload(); await upload({ command_id: q.json.command.id, command_result: 'done' });   // clean up
});

test('a user cannot run the pump of a device that is not assigned to them', async () => {
  const r = await call('/api/my/pump', { method: 'POST', user: 2, body: { device_id: 1, action: 'on' } });
  assert.equal(r.status, 403);
});

test('an offline device does not get a command queued', async () => {
  db.lastSeen = Date.now() - 5 * 60 * 1000;
  const r = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'on' } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /offline/);
});

test('not logged in is rejected, and normal users cannot use the admin endpoint', async () => {
  assert.equal((await call('/api/my/pump', { method: 'POST', body: { device_id: 1, action: 'on' } })).status, 401);
  assert.equal((await call('/api/admin/devices/1/pump', { method: 'POST', user: 1 })).status, 403);
});

test('Pump OFF replaces a waiting ON and tells the device to switch off', async () => {
  db.lastSeen = Date.now();
  const on = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'on' } });
  assert.equal(on.status, 202);
  const off = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'off' } });
  assert.equal(off.status, 202, 'OFF is accepted even while an ON is still waiting');
  const r = await upload();
  assert.equal(r.json.pump_command_id, off.json.command.id, 'only the OFF is delivered');
  assert.equal(r.json.pump_command_on, 0);
  await upload({ command_id: off.json.command.id, command_result: 'done' });
  const ov = await call('/api/my/overview?device_id=1', { user: 1 });
  assert.equal(ov.json.pump_command.action, 'pump_off');
  assert.equal(ov.json.pump_command.status, 'done');
});

test('an invalid pump action is rejected', async () => {
  db.lastSeen = Date.now();
  const r = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1, action: 'explode' } });
  assert.equal(r.status, 400);
  const missing = await call('/api/my/pump', { method: 'POST', user: 1, body: { device_id: 1 } });
  assert.equal(missing.status, 400);
});
