// Creates the first administrator and the first device.
// Usage:  node seed.js admin@example.com YourPassword123
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'greenhouse'
  });

  const email = (process.argv[2] || 'admin@example.com').toLowerCase();
  const password = process.argv[3] || 'ChangeMe123!';
  const hash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin', active = 1`,
    [email, hash]);

  let [devs] = await pool.query('SELECT id, name, api_key FROM devices ORDER BY id LIMIT 1');
  if (!devs[0]) {
    const key = crypto.randomBytes(16).toString('hex');
    const [r] = await pool.query('INSERT INTO devices (name, api_key) VALUES (?, ?)', ['Greenhouse 1', key]);
    await pool.query('INSERT INTO settings (device_id) VALUES (?)', [r.insertId]);
    devs = [{ id: r.insertId, name: 'Greenhouse 1', api_key: key }];
  }

  const [adm] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  await pool.query('INSERT IGNORE INTO assignments (user_id, device_id) VALUES (?, ?)', [adm[0].id, devs[0].id]);

  console.log('Admin account :', email);
  console.log('Device        :', devs[0].name, '(id ' + devs[0].id + ')');
  console.log('DEVICE KEY    :', devs[0].api_key, '   <-- the ESP32 will use this');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
