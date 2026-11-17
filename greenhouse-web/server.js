require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const stats = require('./lib/stats');
const ai = require('./lib/ai');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // No .env yet: use a temporary secret so the site still starts. Logins end when the server restarts.
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('Note: JWT_SECRET is not set (no .env file). Using a temporary secret. Copy .env.example to .env for a permanent one.');
}

const MAX_ADMINS = Number(process.env.MAX_ADMINS) || 2;     // registered administrators allowed
const MAX_USERS = Number(process.env.MAX_USERS) || 10;       // registered normal users allowed
const STALE_SECONDS = Number(process.env.STALE_SECONDS) || 60;          // no reading for this long = device offline
const MIN_READINGS_FOR_AI = Number(process.env.MIN_READINGS_FOR_AI) || 20;
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 20;         // new AI generations per user per 24 h
const AI_COOLDOWN_S = Number(process.env.AI_COOLDOWN_S) || 15;
const MAX_ROWS_PER_DEVICE = 50000;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'greenhouse',
  waitForConnections: true,
  connectionLimit: 10
});

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Small helpers ----------
function httpErr(status, message, extra) { return Object.assign(new Error(message), { status, extra }); }

async function log(userId, action, detail, deviceId) {          // best effort: never breaks a request
  try {
    await pool.query('INSERT INTO activity_log (user_id, device_id, action, detail) VALUES (?, ?, ?, ?)',
      [userId || null, deviceId || null, action, detail ? String(detail).slice(0, 255) : null]);
  } catch (e) { console.error('activity log failed:', e.message); }
}

function toInt(v) { const n = Number(v); return Number.isInteger(n) ? n : null; }

function parseRange(q) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600 * 1000);
  if (isNaN(from) || isNaN(to)) throw httpErr(400, 'Invalid date range');
  if (from >= to) throw httpErr(400, 'The start of the range must be before its end');
  if (to - from > 90 * 24 * 3600 * 1000) throw httpErr(400, 'The date range is limited to 90 days');
  return { from, to };
}

// ---------- Middleware: who is calling, and are they allowed? ----------
// Roles are checked against the DATABASE on every request (not only in the token),
// so deactivating an account or changing a role takes effect immediately.
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expired, please log in again' }); }

  const [rows] = await pool.query('SELECT id, email, role, active FROM users WHERE id = ?', [payload.id]);
  const user = rows[0];
  if (!user || !user.active) return res.status(403).json({ error: 'Account is deactivated' });
  req.user = user;
  next();
}

async function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    await log(req.user.id, 'access_denied', `admin function: ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Administrators only' });
  }
  next();
}

// A user may only touch devices assigned to them.
async function requireDevice(req, raw) {
  const id = toInt(raw);
  if (id === null) throw httpErr(400, 'device_id is required');
  const [ok] = await pool.query('SELECT 1 FROM assignments WHERE user_id = ? AND device_id = ?', [req.user.id, id]);
  if (!ok[0]) {
    await log(req.user.id, 'access_denied', `device ${id}`, id);
    throw httpErr(403, 'You are not assigned to this device');
  }
  return id;
}

// ---------- Accounts ----------
const loginFails = new Map();   // simple brute-force protection: 5 failures / 15 min per email+IP
function failKey(req, email) { return req.ip + '|' + email; }

async function slotsLeft() {
  const [[c]] = await pool.query("SELECT SUM(role = 'admin') AS admins, SUM(role = 'user') AS users FROM users");
  return { admins_left: Math.max(0, MAX_ADMINS - Number(c.admins || 0)), users_left: Math.max(0, MAX_USERS - Number(c.users || 0)), max_admins: MAX_ADMINS, max_users: MAX_USERS };
}
app.get('/api/register/slots', async (req, res) => res.json(await slotsLeft()));

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'user';
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || email.length > 120)
    return res.status(400).json({ error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 72)
    return res.status(400).json({ error: 'Password must be 8 to 72 characters' });

  const hash = await bcrypt.hash(password, 10);
  const limit = role === 'admin' ? MAX_ADMINS : MAX_USERS;
  try {
    // One statement checks the limit and inserts, so two people cannot take the last slot together.
    const [r] = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       SELECT ?, ?, ? FROM DUAL WHERE (SELECT COUNT(*) FROM users WHERE role = ?) < ?`,
      [email.toLowerCase(), hash, role, role, limit]);
    if (!r.affectedRows)
      return res.status(403).json({ error: role === 'admin' ? `Administrator accounts are full (maximum ${MAX_ADMINS}).` : `User accounts are full (maximum ${MAX_USERS}).` });
    await log(r.insertId, 'register', `${email.toLowerCase()} as ${role}`);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That email is already registered' });
    throw e;
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string')
    return res.status(400).json({ error: 'Email and password are required' });

  const key = failKey(req, email.toLowerCase());
  const f = loginFails.get(key);
  if (f && f.count >= 5 && f.until > Date.now())
    return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    loginFails.set(key, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
    await log(user ? user.id : null, 'login_failed', email.toLowerCase().slice(0, 120));
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'Account is deactivated' });

  loginFails.delete(key);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '8h' });
  await log(user.id, 'login', null);
  res.json({ token, email: user.email, role: user.role });
});

app.get('/api/me', auth, (req, res) => res.json({ email: req.user.email, role: req.user.role }));

// ---------- Settings (shared by users and admins) ----------
const SETTING_LIMITS = { temp_on: [10, 50], temp_off: [5, 49], soil_low: [5, 90] };

function validateSettings(b) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(SETTING_LIMITS)) {
    const n = Number(b[k]);
    if (b[k] === undefined || b[k] === null || b[k] === '' || !Number.isFinite(n) || n < lo || n > hi)
      throw httpErr(400, `${k} must be a number between ${lo} and ${hi}`);
    out[k] = Math.round(n * 10) / 10;
  }
  if (out.temp_off > out.temp_on - 1) throw httpErr(400, 'Fan OFF temperature must be at least 1 °C below the fan ON temperature');
  return out;
}

async function getSettings(deviceId) {
  await pool.query('INSERT IGNORE INTO settings (device_id) VALUES (?)', [deviceId]);
  const [rows] = await pool.query(
    'SELECT temp_on, temp_off, soil_low, version, acked_version, acked_at, updated_at FROM settings WHERE device_id = ?', [deviceId]);
  const s = rows[0];
  return { ...s, acknowledged: s.acked_version >= s.version };
}

async function saveSettings(deviceId, body, userId) {
  const v = validateSettings(body || {});
  const cur = await getSettings(deviceId);
  if (cur.temp_on === v.temp_on && cur.temp_off === v.temp_off && cur.soil_low === v.soil_low)
    return { changed: false, settings: cur };
  await pool.query(
    'UPDATE settings SET temp_on = ?, temp_off = ?, soil_low = ?, version = version + 1, updated_by = ? WHERE device_id = ?',
    [v.temp_on, v.temp_off, v.soil_low, userId, deviceId]);
  await log(userId, 'settings_change', `fan on ${v.temp_on}, fan off ${v.temp_off}, pump below ${v.soil_low}`, deviceId);
  return { changed: true, settings: await getSettings(deviceId) };
}

// ---------- Manual pump command: website -> backend -> ESP32 -> acknowledgement ----------
// The ESP32 still enforces its own pump time limit and refuses the command during a sensor fault,
// so this can never override the device's safety protection.
const COMMAND_TTL_SECONDS = Number(process.env.COMMAND_TTL_SECONDS) || 60;   // not picked up by then = expired
const PUMP_ACTIONS = { on: 'pump_on', off: 'pump_off' };
const COMMAND_RESULTS = {
  done: 'The device confirmed it',
  rejected_fault: 'Rejected by the device: a sensor fault is active',
  rejected_busy: 'Rejected by the device: the pump had only just stopped'
};

async function expireCommands(deviceId) {
  await pool.query(
    "UPDATE device_commands SET status = 'expired', result = 'The device did not pick it up in time' " +
    "WHERE device_id = ? AND status IN ('pending','sent') AND requested_at < (NOW() - INTERVAL ? SECOND)",
    [deviceId, COMMAND_TTL_SECONDS]);
}

async function latestCommand(deviceId) {
  await expireCommands(deviceId);
  const [rows] = await pool.query(
    `SELECT c.id, c.action, c.status, c.result, c.requested_at, c.sent_at, c.acked_at, u.email AS requested_by
       FROM device_commands c LEFT JOIN users u ON u.id = c.requested_by
      WHERE c.device_id = ? ORDER BY c.id DESC LIMIT 1`, [deviceId]);
  return rows[0] || null;
}

async function queuePumpCommand(deviceId, userId, action) {
  const act = PUMP_ACTIONS[action];
  if (!act) throw httpErr(400, 'action must be "on" or "off"');
  const [[dev]] = await pool.query('SELECT TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS age FROM devices WHERE id = ?', [deviceId]);
  if (!dev) throw httpErr(404, 'Device not found');
  if (dev.age === null || dev.age > STALE_SECONDS) throw httpErr(409, 'The device is offline, so the pump command was not sent');
  const cur = await latestCommand(deviceId);
  if (act === 'pump_off') {
    // Stopping the pump always wins: it replaces anything still waiting.
    await pool.query("UPDATE device_commands SET status = 'expired', result = 'Replaced by a newer command' WHERE device_id = ? AND status IN ('pending','sent')", [deviceId]);
  } else if (cur && (cur.status === 'pending' || cur.status === 'sent')) {
    throw httpErr(409, 'A pump command is already waiting for the device');
  }
  const [r] = await pool.query('INSERT INTO device_commands (device_id, action, requested_by) VALUES (?, ?, ?)', [deviceId, act, userId]);
  await log(userId, 'pump_command', `manual pump ${action} requested`, deviceId);
  return { id: r.insertId, action: act, status: 'pending' };
}

// ---------- ESP32 -> server ----------
const STATES = ['IDLE', 'COOLING', 'WATERING', 'FAULT'];
function numOrNull(v, min, max) {           // null is allowed (sensor failed); bad numbers are not
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
}

async function deviceFromKey(key) {
  if (typeof key !== 'string') throw httpErr(401, 'Missing device_key');
  const [devs] = await pool.query('SELECT id FROM devices WHERE api_key = ?', [key]);
  if (!devs[0]) throw httpErr(401, 'Unknown device key');
  return devs[0].id;
}

// Creates alerts for the reading. Same alert is not repeated within 10 minutes.
async function raiseAlert(deviceId, ruleId, type, severity, message) {
  const [dup] = await pool.query(
    'SELECT 1 FROM alerts WHERE device_id = ? AND message = ? AND created_at > (NOW() - INTERVAL 10 MINUTE) LIMIT 1', [deviceId, message]);
  if (dup[0]) return;
  await pool.query('INSERT INTO alerts (device_id, rule_id, type, severity, message) VALUES (?, ?, ?, ?, ?)',
    [deviceId, ruleId, type, severity, message]);
}

async function evaluateAlerts(deviceId, r) {
  if (r.temperature === null) await raiseAlert(deviceId, null, 'sensor', 'critical', 'Temperature sensor is not reporting (sensor failure)');
  if (r.soil_moisture === null) await raiseAlert(deviceId, null, 'sensor', 'critical', 'Soil moisture sensor is not reporting (sensor failure)');
  if (r.state === 'FAULT') await raiseAlert(deviceId, null, 'fault', 'critical', 'Device entered FAULT state (safe shutdown)');

  const [rules] = await pool.query('SELECT id, metric, operator, threshold, message FROM alert_rules WHERE device_id = ? AND enabled = 1', [deviceId]);
  for (const rule of rules) {
    const val = r[rule.metric];
    if (val === null || val === undefined) continue;
    const hit = rule.operator === '>' ? val > rule.threshold : val < rule.threshold;
    if (hit) await raiseAlert(deviceId, rule.id, 'rule', 'warning', `${rule.message} (${rule.metric.replace('_', ' ')} ${val} ${rule.operator} ${rule.threshold})`);
  }
}

app.post('/api/device/readings', async (req, res) => {
  const b = req.body || {};
  const deviceId = await deviceFromKey(b.device_key);

  const temperature = numOrNull(b.temperature, -40, 85);
  const humidity = numOrNull(b.humidity, 0, 100);
  const soil = numOrNull(b.soil_moisture, 0, 100);
  if ([temperature, humidity, soil].some(Number.isNaN))
    return res.status(400).json({ error: 'A reading is out of range' });
  if (b.state !== undefined && b.state !== null && !STATES.includes(b.state))
    return res.status(400).json({ error: 'Unknown state' });

  const flag = (v) => (v === undefined || v === null ? null : v ? 1 : 0);
  const state = b.state || null;
  await pool.query(
    `INSERT INTO readings (device_id, temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [deviceId, temperature, humidity, soil, state, flag(b.fan_on), flag(b.pump_on), flag(b.light_on)]);
  await pool.query('UPDATE devices SET last_seen = NOW() WHERE id = ?', [deviceId]);

  // Acknowledgement: the device reports which settings version it is running.
  const sv = toInt(b.settings_version);
  if (sv !== null && sv > 0)
    await pool.query('UPDATE settings SET acked_version = ?, acked_at = NOW() WHERE device_id = ? AND ? > acked_version AND ? <= version', [sv, deviceId, sv, sv]);

  // Acknowledgement of a manual pump command (the device says what it did with it).
  const cid = toInt(b.command_id);
  if (cid !== null && cid > 0 && typeof b.command_result === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_RESULTS, b.command_result)) {
    const [u] = await pool.query(
      "UPDATE device_commands SET status = ?, result = ?, acked_at = NOW() WHERE id = ? AND device_id = ? AND status IN ('pending','sent','expired')",
      [b.command_result === 'done' ? 'done' : 'rejected', COMMAND_RESULTS[b.command_result], cid, deviceId]);
    if (u.affectedRows) await log(null, 'pump_result', `command ${cid}: ${b.command_result}`, deviceId);
  }

  await evaluateAlerts(deviceId, { temperature, humidity, soil_moisture: soil, state });

  const s = await getSettings(deviceId);   // the reply carries the newest settings back to the hardware
  const reply = { ok: true, settings: { version: s.version, temp_on: s.temp_on, temp_off: s.temp_off, soil_low: s.soil_low } };

  await expireCommands(deviceId);          // a waiting pump command is handed to the device in the same reply
  const [cmd] = await pool.query("SELECT id, action FROM device_commands WHERE device_id = ? AND status IN ('pending','sent') ORDER BY id DESC LIMIT 1", [deviceId]);
  if (cmd[0]) {
    reply.pump_command_id = cmd[0].id;
    reply.pump_command_on = cmd[0].action === 'pump_on' ? 1 : 0;      // 1 = switch the pump on, 0 = switch it off
    await pool.query("UPDATE device_commands SET status = 'sent', sent_at = COALESCE(sent_at, NOW()) WHERE id = ?", [cmd[0].id]);
  }
  res.json(reply);
});

app.get('/api/device/settings', async (req, res) => {
  const deviceId = await deviceFromKey(req.headers['x-device-key']);
  const s = await getSettings(deviceId);
  res.json({ version: s.version, temp_on: s.temp_on, temp_off: s.temp_off, soil_low: s.soil_low });
});

// ---------- Shared data queries ----------
const DEVICE_SELECT = `SELECT d.id, d.name, d.last_seen, TIMESTAMPDIFF(SECOND, d.last_seen, NOW()) AS age_seconds FROM devices d`;
function withOnline(d) { return { ...d, online: d.age_seconds !== null && d.age_seconds <= STALE_SECONDS }; }

async function loadRows(deviceId, from, to) {
  const [rows] = await pool.query(
    `SELECT UNIX_TIMESTAMP(created_at) AS t, temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on
       FROM readings WHERE device_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT ?`, [deviceId, from, to, MAX_ROWS_PER_DEVICE]);
  return rows.reverse().map((r) => ({ ...r, t: Number(r.t) }));
}

// Averages per time bucket, so long ranges stay fast and charts stay readable.
async function loadSeries(deviceIds, from, to) {
  if (!deviceIds.length) return { bucket_seconds: 0, series: {} };
  const bucket = Math.max(10, Math.ceil((to - from) / 1000 / 200));
  const [rows] = await pool.query(
    `SELECT device_id, FLOOR(UNIX_TIMESTAMP(created_at) / ${bucket}) * ${bucket} AS bucket_t,
            AVG(temperature) AS temperature, AVG(humidity) AS humidity, AVG(soil_moisture) AS soil_moisture, COUNT(*) AS n
       FROM readings WHERE device_id IN (?) AND created_at >= ? AND created_at <= ?
      GROUP BY device_id, bucket_t ORDER BY bucket_t`, [deviceIds, from, to]);
  const series = {};
  for (const r of rows) {
    (series[r.device_id] = series[r.device_id] || []).push({
      t: Number(r.bucket_t) * 1000,
      temperature: r.temperature === null ? null : Number(Number(r.temperature).toFixed(2)),
      humidity: r.humidity === null ? null : Number(Number(r.humidity).toFixed(2)),
      soil_moisture: r.soil_moisture === null ? null : Number(Number(r.soil_moisture).toFixed(2))
    });
  }
  return { bucket_seconds: bucket, series };
}

async function alertCounts(deviceIds, from, to) {
  if (!deviceIds.length) return {};
  const [rows] = await pool.query(
    `SELECT device_id, type, COUNT(*) AS c FROM alerts
      WHERE device_id IN (?) AND created_at >= ? AND created_at <= ? GROUP BY device_id, type`, [deviceIds, from, to]);
  const out = {};
  for (const r of rows) { (out[r.device_id] = out[r.device_id] || {})[r.type] = Number(r.c); }
  return out;
}

// Builds everything the analytics screens and the AI need. Every number here is calculated in code/SQL.
// Each reading belongs to exactly ONE device, and devices are de-duplicated, so a prototype that is
// shared by several users is never counted more than once.
async function buildBundle({ deviceIds, from, to, withPrevious, includeActions, actionUserId }) {
  const [devs] = deviceIds.length ? await pool.query('SELECT id, name FROM devices WHERE id IN (?) ORDER BY id', [deviceIds]) : [[]];
  const counts = await alertCounts(deviceIds, from, to);
  const rowsByDevice = {};
  const devices = [];
  let prevRowsByDevice = {};

  for (const d of devs) {
    const rows = await loadRows(d.id, from, to);
    rowsByDevice[d.id] = rows;
    const settings = await getSettings(d.id);
    const [rules] = await pool.query('SELECT metric, operator, threshold, message, enabled FROM alert_rules WHERE device_id = ?', [d.id]);
    const last = rows[rows.length - 1] || null;
    const entry = {
      device_id: d.id, name: d.name,
      measured: {
        readings_in_range: rows.length,
        truncated: rows.length >= MAX_ROWS_PER_DEVICE,
        latest_reading: last ? { at: new Date(last.t * 1000).toISOString(), temperature: last.temperature, humidity: last.humidity, soil_moisture: last.soil_moisture, state: last.state } : null,
        alerts_in_range: counts[d.id] || {}
      },
      current_settings: { temp_on: settings.temp_on, temp_off: settings.temp_off, soil_low: settings.soil_low },
      alert_rules: rules,
      stats: stats.summarize(rows),
      anomalies_detected_by_code: stats.detectAnomalies(rows)
    };
    if (withPrevious) {
      const span = to - from;
      const prev = await loadRows(d.id, new Date(from - span), from);
      prevRowsByDevice[d.id] = prev;
      entry.previous_period_stats = stats.summarize(prev);
      entry.comparison_calculated_by_code = prev.length ? stats.compareSummaries(entry.stats, entry.previous_period_stats) : null;
    }
    devices.push(entry);
  }

  const bundle = {
    range: { from: from.toISOString(), to: to.toISOString() },
    device_count: devices.length,
    devices
  };
  if (devices.length > 1) bundle.fleet_metrics_all_readings_counted_once = stats.fleetMetrics(rowsByDevice);

  if (includeActions) {
    const params = [from, to];
    let sql = 'SELECT action, COUNT(*) AS c FROM activity_log WHERE created_at >= ? AND created_at <= ?';
    if (actionUserId) { sql += ' AND user_id = ?'; params.push(actionUserId); }
    const [acts] = await pool.query(sql + ' GROUP BY action', params);
    bundle.recorded_user_actions = Object.fromEntries(acts.map((a) => [a.action, Number(a.c)]));
  }
  return bundle;
}

function totalReadings(bundle) { return bundle.devices.reduce((a, d) => a + d.stats.readings, 0); }

// ---------- AI generation (cache + limits + graceful failure) ----------
async function generateAi(req, { scope, kind, bundle, scopeInfo }) {
  if (!ai.KINDS[kind]) throw httpErr(400, 'Unknown analysis type. Use one of: ' + Object.keys(ai.KINDS).join(', '));
  const have = totalReadings(bundle);
  if (have < MIN_READINGS_FOR_AI)
    throw httpErr(422, `Not enough data for AI analysis: ${have} reading(s) in this range, at least ${MIN_READINGS_FOR_AI} needed. Choose a longer range.`, { code: 'INSUFFICIENT_DATA', have, need: MIN_READINGS_FOR_AI });
  if (kind === 'compare' && bundle.devices.every((d) => !d.comparison_calculated_by_code))
    throw httpErr(422, 'There are no readings in the previous period to compare with.', { code: 'INSUFFICIENT_DATA' });

  const payload = { scope: scopeInfo, ...bundle };
  const { range, recorded_user_actions, ...dataOnly } = payload;  // range moves every minute and logging the request itself changes the action counts; the readings decide the cache key
  const hash = crypto.createHash('sha256').update(JSON.stringify({ scope, kind, dataOnly })).digest('hex');

  const [cached] = await pool.query('SELECT result_json, model, created_at FROM ai_analyses WHERE input_hash = ? AND scope = ? ORDER BY id DESC LIMIT 1', [hash, scope]);
  if (cached[0]) return { result: JSON.parse(cached[0].result_json), model: cached[0].model, generated_at: cached[0].created_at, cached: true };

  const [[recent]] = await pool.query('SELECT COUNT(*) AS c, MAX(created_at) AS last_at, TIMESTAMPDIFF(SECOND, MAX(created_at), NOW()) AS since FROM ai_analyses WHERE user_id = ? AND created_at > (NOW() - INTERVAL 1 DAY)', [req.user.id]);
  if (Number(recent.c) >= AI_DAILY_LIMIT) throw httpErr(429, `Daily AI limit reached (${AI_DAILY_LIMIT}). Cached results are still available.`, { code: 'LIMIT' });
  if (recent.since !== null && Number(recent.since) < AI_COOLDOWN_S) throw httpErr(429, `Please wait ${AI_COOLDOWN_S} seconds between AI requests.`, { code: 'COOLDOWN' });

  const out = await ai.analyze(kind, payload);                  // may throw AiError
  await pool.query('INSERT INTO ai_analyses (user_id, scope, kind, input_hash, model, result_json) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, scope, kind, hash, out.model, JSON.stringify(out.result)]);
  return { result: out.result, model: out.model, generated_at: new Date(), cached: false };
}

async function respondWithAi(req, res, opts) {
  const { bundle } = opts;
  const base = { range: bundle.range, scope: opts.scopeInfo, kind: opts.kind, ...bundle };
  try {
    const g = await generateAi(req, opts);
    await log(req.user.id, 'ai_analysis', `${opts.scope} ${opts.kind}${g.cached ? ' (cached)' : ''}`, opts.deviceId);
    res.json({ ...base, ai: g.result, ai_model: g.model, generated_at: new Date(g.generated_at).toISOString(), cached: g.cached });
  } catch (e) {
    // The calculated statistics are still returned, so the page is useful even if the AI part fails.
    const status = e.status || 500;
    if (!e.status && !(e instanceof ai.AiError)) throw e;
    await log(req.user.id, 'ai_failed', `${opts.scope} ${opts.kind}: ${e.code || (e.extra && e.extra.code) || status}`, opts.deviceId);
    res.status(status).json({ error: e.message, code: e.code || (e.extra && e.extra.code), ...base });
  }
}

// ---------- User: only their own devices and readings ----------
app.get('/api/my/devices', auth, async (req, res) => {
  const [rows] = await pool.query(
    `${DEVICE_SELECT} JOIN assignments a ON a.device_id = d.id WHERE a.user_id = ? ORDER BY d.id`, [req.user.id]);
  res.json(rows.map(withOnline));
});

app.get('/api/my/overview', auth, async (req, res) => {
  const id = await requireDevice(req, req.query.device_id);
  const [[dev]] = await pool.query(`${DEVICE_SELECT} WHERE d.id = ?`, [id]);
  const [last] = await pool.query(
    `SELECT temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on, created_at
       FROM readings WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [id]);
  const [alerts] = await pool.query(
    'SELECT id, type, severity, message, created_at FROM alerts WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 10', [id]);
  res.json({ device: withOnline(dev), stale_after_seconds: STALE_SECONDS, latest: last[0] || null, settings: await getSettings(id), pump_command: await latestCommand(id), alerts });
});

app.get('/api/my/readings', auth, async (req, res) => {
  const deviceId = await requireDevice(req, req.query.device_id);
  const { from, to } = parseRange(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const [rows] = await pool.query(
    `SELECT temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on, created_at
       FROM readings WHERE device_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT ?`, [deviceId, from, to, limit]);
  res.json(rows.reverse());   // oldest first
});

app.get('/api/my/series', auth, async (req, res) => {
  const deviceId = await requireDevice(req, req.query.device_id);
  const { from, to } = parseRange(req.query);
  const s = await loadSeries([deviceId], from, to);
  res.json({ range: { from: from.toISOString(), to: to.toISOString() }, bucket_seconds: s.bucket_seconds, points: s.series[deviceId] || [] });
});

app.get('/api/my/alerts', auth, async (req, res) => {
  const deviceId = await requireDevice(req, req.query.device_id);
  const { from, to } = parseRange(req.query);
  const [rows] = await pool.query(
    `SELECT id, type, severity, message, created_at FROM alerts
      WHERE device_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 200`, [deviceId, from, to]);
  res.json(rows);
});

app.get('/api/my/settings', auth, async (req, res) => {
  const id = await requireDevice(req, req.query.device_id);
  res.json(await getSettings(id));
});

app.put('/api/my/settings', auth, async (req, res) => {
  const id = await requireDevice(req, (req.body || {}).device_id);
  res.json(await saveSettings(id, req.body, req.user.id));
});

app.post('/api/my/pump', auth, async (req, res) => {
  const id = await requireDevice(req, (req.body || {}).device_id);       // only assigned devices
  res.status(202).json({ command: await queuePumpCommand(id, req.user.id, (req.body || {}).action) });
});

app.get('/api/my/rules', auth, async (req, res) => {
  const id = await requireDevice(req, req.query.device_id);
  const [rows] = await pool.query('SELECT id, metric, operator, threshold, message, enabled FROM alert_rules WHERE device_id = ? ORDER BY id', [id]);
  res.json(rows);
});

app.get('/api/my/analytics', auth, async (req, res) => {
  const id = await requireDevice(req, req.query.device_id);
  const { from, to } = parseRange(req.query);
  res.json(await buildBundle({ deviceIds: [id], from, to, withPrevious: false }));
});

app.post('/api/my/ai', auth, async (req, res) => {
  const b = req.body || {};
  const id = await requireDevice(req, b.device_id);
  const { from, to } = parseRange(b);
  const kind = String(b.kind || 'summary');
  const bundle = await buildBundle({ deviceIds: [id], from, to, withPrevious: kind === 'compare' });
  await respondWithAi(req, res, { scope: 'user', kind, bundle, deviceId: id, scopeInfo: { type: 'one greenhouse', device_id: id, name: bundle.devices[0] ? bundle.devices[0].name : null } });
});

// ---------- Admin ----------
const admin = express.Router();
admin.use(auth, adminOnly);

admin.get('/overview', async (req, res) => {
  const [[u]] = await pool.query('SELECT COUNT(*) AS total, SUM(active = 1) AS active, SUM(role = \'admin\') AS admins FROM users');
  const [[d]] = await pool.query('SELECT COUNT(*) AS total, SUM(last_seen IS NOT NULL AND last_seen > (NOW() - INTERVAL ? SECOND)) AS online FROM devices', [STALE_SECONDS]);
  const [[r]] = await pool.query('SELECT COUNT(*) AS total FROM readings');
  const [[a]] = await pool.query('SELECT COUNT(*) AS total FROM alerts WHERE created_at > (NOW() - INTERVAL 1 DAY)');
  const [[asg]] = await pool.query('SELECT COUNT(*) AS total FROM assignments');
  const [recent] = await pool.query(
    `SELECT l.id, l.action, l.detail, l.created_at, u.email FROM activity_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 12`);
  res.json({
    users: { total: Number(u.total), active: Number(u.active || 0), admins: Number(u.admins || 0) },
    devices: { total: Number(d.total), online: Number(d.online || 0) },
    assignments: Number(asg.total), readings: Number(r.total), alerts_24h: Number(a.total), stale_after_seconds: STALE_SECONDS, recent_activity: recent
  });
});

admin.get('/users', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.email, u.role, u.active, u.created_at, COUNT(a.device_id) AS device_count
       FROM users u LEFT JOIN assignments a ON a.user_id = u.id GROUP BY u.id ORDER BY u.id`);
  res.json(rows);
});

admin.put('/users/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const { active, role } = req.body || {};
  if (id === null) return res.status(400).json({ error: 'Bad user id' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own account here' });
  if (role !== undefined && !['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Bad role' });
  if (active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  const [[u]] = await pool.query('SELECT email FROM users WHERE id = ?', [id]);
  if (!u) return res.status(404).json({ error: 'User not found' });

  if (role !== undefined) {
    const [[cur]] = await pool.query('SELECT role FROM users WHERE id = ?', [id]);
    if (cur.role !== role) {
      const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE role = ?', [role]);
      if (Number(c.n) >= (role === 'admin' ? MAX_ADMINS : MAX_USERS)) return res.status(400).json({ error: `Cannot change role: the maximum number of ${role === 'admin' ? 'administrators' : 'users'} (${role === 'admin' ? MAX_ADMINS : MAX_USERS}) is already reached.` });
    }
  }
  if (active !== undefined) { await pool.query('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, id]); await log(req.user.id, active ? 'user_activate' : 'user_deactivate', u.email); }
  if (role !== undefined) { await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]); await log(req.user.id, 'user_role', `${u.email} -> ${role}`); }
  res.json({ ok: true });
});

// Devices: create, read, update, delete
function deviceName(v) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 60) throw httpErr(400, 'Device name must be 1 to 60 characters');
  return v.trim();
}

admin.get('/devices', async (req, res) => {
  const [rows] = await pool.query(
    `${DEVICE_SELECT} ORDER BY d.id`);
  const [as] = await pool.query('SELECT a.device_id, u.id AS user_id, u.email FROM assignments a JOIN users u ON u.id = a.user_id ORDER BY u.email');
  const out = [];
  for (const d of rows) {
    const s = await getSettings(d.id);
    out.push({ ...withOnline(d), users: as.filter((x) => x.device_id === d.id).map((x) => ({ id: x.user_id, email: x.email })), settings: s });
  }
  res.json(out);
});

admin.post('/devices', async (req, res) => {
  const name = deviceName((req.body || {}).name);
  const key = crypto.randomBytes(16).toString('hex');
  const [r] = await pool.query('INSERT INTO devices (name, api_key) VALUES (?, ?)', [name, key]);
  await pool.query('INSERT INTO settings (device_id) VALUES (?)', [r.insertId]);
  await log(req.user.id, 'device_create', name, r.insertId);
  res.json({ id: r.insertId, name, device_key: key });          // the key is shown only now
});

admin.put('/devices/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const name = deviceName((req.body || {}).name);
  const [r] = await pool.query('UPDATE devices SET name = ? WHERE id = ?', [name, id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Device not found' });
  await log(req.user.id, 'device_rename', name, id);
  res.json({ ok: true });
});

admin.post('/devices/:id/rotate-key', async (req, res) => {
  const id = toInt(req.params.id);
  const key = crypto.randomBytes(16).toString('hex');
  const [r] = await pool.query('UPDATE devices SET api_key = ? WHERE id = ?', [key, id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Device not found' });
  await log(req.user.id, 'device_key_rotate', null, id);
  res.json({ device_key: key });
});

admin.delete('/devices/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const [[d]] = await pool.query('SELECT name FROM devices WHERE id = ?', [id]);
  if (!d) return res.status(404).json({ error: 'Device not found' });
  await pool.query('DELETE FROM devices WHERE id = ?', [id]);
  await log(req.user.id, 'device_delete', d.name);
  res.json({ ok: true });
});

admin.put('/devices/:id/settings', async (req, res) => {
  const id = toInt(req.params.id);
  const [[d]] = await pool.query('SELECT id FROM devices WHERE id = ?', [id]);
  if (!d) return res.status(404).json({ error: 'Device not found' });
  res.json(await saveSettings(id, req.body, req.user.id));
});

admin.post('/devices/:id/pump', async (req, res) => {
  const id = toInt(req.params.id);
  const [[d]] = await pool.query('SELECT id FROM devices WHERE id = ?', [id]);
  if (!d) return res.status(404).json({ error: 'Device not found' });
  res.status(202).json({ command: await queuePumpCommand(id, req.user.id, (req.body || {}).action) });
});

// Assignments
admin.get('/assignments', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.user_id, u.email, a.device_id, d.name AS device_name FROM assignments a
       JOIN users u ON u.id = a.user_id JOIN devices d ON d.id = a.device_id ORDER BY u.email, d.id`);
  res.json(rows);
});

admin.post('/assign', async (req, res) => {
  const { user_id, device_id } = req.body || {};
  if (!Number.isInteger(user_id) || !Number.isInteger(device_id)) return res.status(400).json({ error: 'user_id and device_id are required' });
  try {
    await pool.query('INSERT IGNORE INTO assignments (user_id, device_id) VALUES (?, ?)', [user_id, device_id]);
    await log(req.user.id, 'assign', `user ${user_id} -> device ${device_id}`, device_id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'User or device not found' });
    throw e;
  }
});

admin.put('/assign', async (req, res) => {       // move a user from one prototype to another
  const { user_id, device_id, new_device_id } = req.body || {};
  if (![user_id, device_id, new_device_id].every(Number.isInteger)) return res.status(400).json({ error: 'user_id, device_id and new_device_id are required' });
  try {
    const [r] = await pool.query('UPDATE assignments SET device_id = ? WHERE user_id = ? AND device_id = ?', [new_device_id, user_id, device_id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'That assignment does not exist' });
    await log(req.user.id, 'reassign', `user ${user_id}: device ${device_id} -> ${new_device_id}`, new_device_id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'The user already has that device' });
    if (e.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Device not found' });
    throw e;
  }
});

admin.delete('/assign', async (req, res) => {
  const { user_id, device_id } = req.body || {};
  if (!Number.isInteger(user_id) || !Number.isInteger(device_id)) return res.status(400).json({ error: 'user_id and device_id are required' });
  await pool.query('DELETE FROM assignments WHERE user_id = ? AND device_id = ?', [user_id, device_id]);
  await log(req.user.id, 'unassign', `user ${user_id} x device ${device_id}`, device_id);
  res.json({ ok: true });
});

// Alert rules: create, read, update, delete
const RULE_LIMITS = { temperature: [-40, 85], humidity: [0, 100], soil_moisture: [0, 100] };
function validateRule(b) {
  if (!Object.keys(RULE_LIMITS).includes(b.metric)) throw httpErr(400, 'metric must be temperature, humidity or soil_moisture');
  if (!['>', '<'].includes(b.operator)) throw httpErr(400, 'operator must be > or <');
  const t = Number(b.threshold), [lo, hi] = RULE_LIMITS[b.metric] || [0, 0];
  if (b.threshold === '' || b.threshold === null || !Number.isFinite(t) || t < lo || t > hi) throw httpErr(400, `threshold must be a number between ${lo} and ${hi}`);
  if (typeof b.message !== 'string' || !b.message.trim() || b.message.trim().length > 120) throw httpErr(400, 'Message must be 1 to 120 characters');
  return { metric: b.metric, operator: b.operator, threshold: t, message: b.message.trim(), enabled: b.enabled === false ? 0 : 1 };
}

admin.get('/rules', async (req, res) => {
  const id = req.query.device_id ? toInt(req.query.device_id) : null;
  const [rows] = id !== null
    ? await pool.query('SELECT * FROM alert_rules WHERE device_id = ? ORDER BY id', [id])
    : await pool.query('SELECT * FROM alert_rules ORDER BY device_id, id');
  res.json(rows);
});

admin.post('/rules', async (req, res) => {
  const deviceId = toInt((req.body || {}).device_id);
  const v = validateRule(req.body || {});
  const [[d]] = await pool.query('SELECT id FROM devices WHERE id = ?', [deviceId]);
  if (!d) return res.status(404).json({ error: 'Device not found' });
  const [r] = await pool.query('INSERT INTO alert_rules (device_id, metric, operator, threshold, message, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    [deviceId, v.metric, v.operator, v.threshold, v.message, v.enabled]);
  await log(req.user.id, 'rule_create', `${v.metric} ${v.operator} ${v.threshold}`, deviceId);
  res.json({ id: r.insertId });
});

admin.put('/rules/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const v = validateRule(req.body || {});
  const [r] = await pool.query('UPDATE alert_rules SET metric = ?, operator = ?, threshold = ?, message = ?, enabled = ? WHERE id = ?',
    [v.metric, v.operator, v.threshold, v.message, v.enabled, id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Rule not found' });
  await log(req.user.id, 'rule_update', `rule ${id}`);
  res.json({ ok: true });
});

admin.delete('/rules/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const [r] = await pool.query('DELETE FROM alert_rules WHERE id = ?', [id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Rule not found' });
  await log(req.user.id, 'rule_delete', `rule ${id}`);
  res.json({ ok: true });
});

// Monitoring across everything
admin.get('/monitor', async (req, res) => {
  const [devs] = await pool.query(`${DEVICE_SELECT} ORDER BY d.id`);
  const out = [];
  for (const d of devs) {
    const [last] = await pool.query('SELECT temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on, created_at FROM readings WHERE device_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [d.id]);
    const [[a]] = await pool.query('SELECT COUNT(*) AS c FROM alerts WHERE device_id = ? AND created_at > (NOW() - INTERVAL 1 DAY)', [d.id]);
    const [users] = await pool.query('SELECT u.email FROM assignments a JOIN users u ON u.id = a.user_id WHERE a.device_id = ? ORDER BY u.email', [d.id]);
    out.push({ ...withOnline(d), latest: last[0] || null, alerts_24h: Number(a.c), users: users.map((u) => u.email) });
  }
  res.json(out);
});

async function adminDeviceIds(q) {
  const userId = q.user_id ? toInt(q.user_id) : null;
  const deviceId = q.device_id ? toInt(q.device_id) : null;
  if ((q.user_id && userId === null) || (q.device_id && deviceId === null)) throw httpErr(400, 'Bad user_id or device_id');
  const where = [], params = [];
  let sql = 'SELECT DISTINCT d.id FROM devices d';
  if (userId !== null) { sql += ' JOIN assignments a ON a.device_id = d.id'; where.push('a.user_id = ?'); params.push(userId); }
  if (deviceId !== null) { where.push('d.id = ?'); params.push(deviceId); }
  const [rows] = await pool.query(sql + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY d.id', params);
  return { ids: rows.map((r) => r.id), userId, deviceId };
}

admin.get('/alerts', async (req, res) => {
  const { from, to } = parseRange(req.query);
  const { ids } = await adminDeviceIds(req.query);
  if (!ids.length) return res.json([]);
  const [rows] = await pool.query(
    `SELECT al.id, al.device_id, d.name AS device_name, al.type, al.severity, al.message, al.created_at
       FROM alerts al JOIN devices d ON d.id = al.device_id
      WHERE al.device_id IN (?) AND al.created_at >= ? AND al.created_at <= ? ORDER BY al.created_at DESC, al.id DESC LIMIT 200`, [ids, from, to]);
  res.json(rows);
});

admin.get('/activity', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const userId = req.query.user_id ? toInt(req.query.user_id) : null;
  const [rows] = await pool.query(
    `SELECT l.id, l.action, l.detail, l.device_id, l.created_at, u.email FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
      ${userId !== null ? 'WHERE l.user_id = ?' : ''} ORDER BY l.id DESC LIMIT ?`, userId !== null ? [userId, limit] : [limit]);
  res.json(rows);
});

admin.get('/series', async (req, res) => {
  const { from, to } = parseRange(req.query);
  const { ids } = await adminDeviceIds(req.query);
  const [devs] = ids.length ? await pool.query('SELECT id, name FROM devices WHERE id IN (?) ORDER BY id', [ids]) : [[]];
  const s = await loadSeries(ids, from, to);
  res.json({ range: { from: from.toISOString(), to: to.toISOString() }, bucket_seconds: s.bucket_seconds, devices: devs.map((d) => ({ id: d.id, name: d.name, points: s.series[d.id] || [] })) });
});

admin.get('/analytics', async (req, res) => {
  const { from, to } = parseRange(req.query);
  const f = await adminDeviceIds(req.query);
  const bundle = await buildBundle({ deviceIds: f.ids, from, to, withPrevious: false, includeActions: true, actionUserId: f.userId });
  bundle.filters = { user_id: f.userId, device_id: f.deviceId };
  res.json(bundle);
});

admin.post('/ai', async (req, res) => {
  const b = req.body || {};
  const { from, to } = parseRange(b);
  const f = await adminDeviceIds(b);
  const kind = String(b.kind || 'summary');
  const bundle = await buildBundle({ deviceIds: f.ids, from, to, withPrevious: kind === 'compare', includeActions: true, actionUserId: f.userId });
  const scopeInfo = { type: 'system-wide', user_filter: f.userId, device_filter: f.deviceId, devices_included: bundle.devices.map((d) => d.name) };
  await respondWithAi(req, res, { scope: 'system', kind, bundle, scopeInfo, deviceId: f.deviceId });
});

app.use('/api/admin', admin);

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

// ---------- First start: create database, tables and the built-in admin ----------
async function initDatabase() {
  const dbName = process.env.DB_NAME || 'greenhouse';
  if (!/^\w+$/.test(dbName)) throw new Error('DB_NAME may only contain letters, numbers and _');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', multipleStatements: true
  });
  try {
    let sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    sql = sql.replace(/CREATE DATABASE IF NOT EXISTS greenhouse/i, `CREATE DATABASE IF NOT EXISTS ${dbName}`).replace(/USE greenhouse;/i, `USE ${dbName};`);
    await conn.query(sql);               // every statement uses IF NOT EXISTS, so this is safe on every start
  } finally { await conn.end(); }
}

const port = process.env.PORT || 3000;
if (require.main === module) {
  initDatabase().then(() => app.listen(port, () => console.log(`Greenhouse web running at http://localhost:${port}`)))
    .catch((e) => { console.error('\nCould not set up the database: ' + e.message + '\nIs MySQL running (XAMPP > Start MySQL) and are DB_USER / DB_PASSWORD in .env correct?'); process.exit(1); });
}
module.exports = app;
