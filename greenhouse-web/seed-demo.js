// Fills the database with demo users, two greenhouses and 3 days of realistic readings,
// so the dashboards, analytics and AI can be demonstrated before the hardware is connected.
//
//   node seed-demo.js            (adds demo data if the demo greenhouses have no readings)
//   node seed-demo.js --reset    (deletes the demo greenhouses' readings and alerts first)
//
// Accounts created (password for both: Demo12345!):
//   alice@demo.test  -> Greenhouse 1
//   bob@demo.test    -> Greenhouse 1 (shared with Alice) and Greenhouse 2
// Run  node seed.js admin@example.com YourPassword123  first if you do not have an admin yet.
//
// Built-in "known" events (useful for testing and for the AI evaluation):
//   Greenhouse 1: heat spike on day 2 (41 C), temperature sensor failure + FAULT state on day 3
//   Greenhouse 2: 3-hour communication gap on day 2, drier soil (pump runs more often)
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);   // repeatable "random"
const noise = (amp) => (rnd() - 0.5) * 2 * amp;
const r1 = (v) => Math.round(v * 10) / 10;

function simulate(opts) {
  const STEP_MIN = 5, POINTS = 3 * 24 * 12;
  const end = Date.now(), start = end - POINTS * STEP_MIN * 60000;
  const rows = [], alerts = [];
  let soil = opts.soilStart, fan = false, pumpLeft = 0;

  for (let i = 0; i < POINTS; i++) {
    const t = start + i * STEP_MIN * 60000;
    const hour = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    const day = Math.floor(i / 288);
    let temp = opts.baseTemp + 5 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + noise(0.4);
    if (fan) temp -= 1.5;
    if (opts.heatSpike && day === 1 && hour >= 14 && hour < 14.5) temp = 41 + noise(0.5);

    soil -= opts.dryRate + (temp > 30 ? 0.1 : 0);
    let pump = false;
    if (pumpLeft > 0) { pump = true; pumpLeft--; soil += 9; }
    else if (soil < 40) pumpLeft = 2;
    soil = Math.max(5, Math.min(95, soil));

    if (temp >= 30) fan = true; else if (temp <= 28) fan = false;
    const humidity = 62 - (temp - 25) * 1.4 + noise(2) + (pump ? 6 : 0);

    let row = { t, temperature: r1(temp), humidity: r1(Math.max(20, Math.min(95, humidity))), soil: r1(soil), fan, pump, light: hour >= 6 && hour < 18 };
    let state = pump ? 'WATERING' : fan ? 'COOLING' : 'IDLE';

    if (opts.sensorFailure && day === 2 && hour >= 10 && hour < 10.5) {       // temperature sensor failure
      row.temperature = null; row.fan = false; state = 'FAULT';
      alerts.push([t, 'sensor', 'critical', 'Temperature sensor is not reporting (sensor failure)']);
      alerts.push([t, 'fault', 'critical', 'Device entered FAULT state (safe shutdown)']);
    }
    if (row.temperature !== null && row.temperature > 35) alerts.push([t, 'rule', 'warning', `Too hot (temperature ${row.temperature} > 35)`]);
    if (row.soil < 25) alerts.push([t, 'rule', 'warning', `Soil critically dry (soil moisture ${row.soil} < 25)`]);

    if (opts.commGap && day === 1 && hour >= 12 && hour < 15) continue;       // no data at all: network outage
    row.state = state;
    rows.push(row);
  }
  return { rows, alerts };
}

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'greenhouse'
  });
  const reset = process.argv.includes('--reset');

  async function ensureDevice(name) {
    const [d] = await pool.query('SELECT id FROM devices WHERE name = ?', [name]);
    if (d[0]) return d[0].id;
    const [r] = await pool.query('INSERT INTO devices (name, api_key) VALUES (?, ?)', [name, crypto.randomBytes(16).toString('hex')]);
    await pool.query('INSERT IGNORE INTO settings (device_id) VALUES (?)', [r.insertId]);
    return r.insertId;
  }
  async function ensureUser(email) {
    const hash = await bcrypt.hash('Demo12345!', 10);
    await pool.query('INSERT IGNORE INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
    const [u] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    return u[0].id;
  }

  const gh1 = await ensureDevice('Greenhouse 1');
  const gh2 = await ensureDevice('Greenhouse 2');
  const alice = await ensureUser('alice@demo.test');
  const bob = await ensureUser('bob@demo.test');
  for (const [u, d] of [[alice, gh1], [bob, gh1], [bob, gh2]]) await pool.query('INSERT IGNORE INTO assignments (user_id, device_id) VALUES (?, ?)', [u, d]);

  for (const id of [gh1, gh2]) {
    const [n] = await pool.query('SELECT COUNT(*) AS c FROM alert_rules WHERE device_id = ?', [id]);
    if (!n[0].c) {
      await pool.query('INSERT INTO alert_rules (device_id, metric, operator, threshold, message) VALUES (?, \'temperature\', \'>\', 35, \'Too hot\'), (?, \'soil_moisture\', \'<\', 25, \'Soil critically dry\')', [id, id]);
    }
  }

  const plans = [
    [gh1, simulate({ baseTemp: 27, soilStart: 70, dryRate: 0.08, heatSpike: true, sensorFailure: true })],
    [gh2, simulate({ baseTemp: 25, soilStart: 55, dryRate: 0.14, commGap: true })]
  ];
  for (const [id, sim] of plans) {
    const [n] = await pool.query('SELECT COUNT(*) AS c FROM readings WHERE device_id = ?', [id]);
    if (n[0].c && !reset) { console.log(`Device ${id} already has readings (use --reset to replace them).`); continue; }
    if (reset) { await pool.query('DELETE FROM readings WHERE device_id = ?', [id]); await pool.query('DELETE FROM alerts WHERE device_id = ?', [id]); }

    const values = sim.rows.map((r) => [id, r.temperature, r.humidity, r.soil, r.state, r.fan ? 1 : 0, r.pump ? 1 : 0, r.light ? 1 : 0, new Date(r.t)]);
    for (let i = 0; i < values.length; i += 500)
      await pool.query('INSERT INTO readings (device_id, temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on, created_at) VALUES ?', [values.slice(i, i + 500)]);

    // keep only the first alert of each kind per hour so the alert list stays readable
    const seen = new Set(), av = [];
    for (const [t, type, sev, msg] of sim.alerts) {
      const k = type + msg + Math.floor(t / 3600000);
      if (seen.has(k)) continue; seen.add(k);
      av.push([id, type, sev, msg, new Date(t)]);
    }
    if (av.length) await pool.query('INSERT INTO alerts (device_id, type, severity, message, created_at) VALUES ?', [av]);
    await pool.query('UPDATE devices SET last_seen = ? WHERE id = ?', [new Date(sim.rows[sim.rows.length - 1].t), id]);
    console.log(`Device ${id}: ${values.length} readings, ${av.length} alerts`);
  }
  console.log('\nDemo accounts (password Demo12345!): alice@demo.test, bob@demo.test');
  console.log('Greenhouse 1 is shared by Alice and Bob; Greenhouse 2 belongs to Bob only.');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
