const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/ai');
const stats = require('../lib/stats');

const rows = Array.from({ length: 30 }, (_, i) => ({ t: 1000 + i * 300, temperature: 25 + (i % 5), humidity: 55, soil_moisture: 50, state: 'IDLE', fan_on: 0, pump_on: 0, light_on: 1 }));
const payload = { devices: [{ name: 'Greenhouse 1', stats: stats.summarize(rows) }] };   // temp avg 27, max 29
const good = { summary: 'Temperature averaged 27 and peaked at 29 during the period.', findings: [{ text: 'Soil moisture stayed at 50.', evidence: 'metrics.soil_moisture.avg' }], recommendations: [{ text: 'Raise the fan threshold.', setting: 'temp_on', suggested_value: 32, evidence: 'metrics.temperature.max' }], confidence: 'medium', limitations: 'Short period.' };

test('a well-grounded answer passes without warnings', () => {
  const r = ai.parseAndValidate(JSON.stringify(good), payload);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.recommendations[0].suggested_value, 32);
});
test('MISLEADING RESULT: invented figures are flagged', () => {
  const bad = { ...good, summary: 'Temperature spiked to 47.3 degrees and humidity fell by 18 percent.' };
  const r = ai.parseAndValidate(JSON.stringify(bad), payload);
  assert.ok(r.warnings.some((w) => w.includes('47.3') && w.includes('18')));
});
test('out-of-range setting suggestion is removed', () => {
  const bad = { ...good, recommendations: [{ text: 'Run the fan almost always.', setting: 'temp_on', suggested_value: 5 }] };
  const r = ai.parseAndValidate(JSON.stringify(bad), payload);
  assert.strictEqual(r.recommendations[0].setting, null);
  assert.ok(r.warnings.some((w) => w.includes('outside the allowed range')));
});
test('unknown setting names are dropped', () => {
  const bad = { ...good, recommendations: [{ text: 'x', setting: 'pump_speed', suggested_value: 3 }] };
  assert.strictEqual(ai.parseAndValidate(JSON.stringify(bad), payload).recommendations[0].setting, null);
});
test('non-JSON answers raise BAD_FORMAT', () => {
  assert.throws(() => ai.parseAndValidate('Sure! Here is my analysis...', payload), (e) => e.code === 'BAD_FORMAT');
});
test('JSON wrapped in a code fence is accepted', () => {
  assert.ok(ai.parseAndValidate('```json\n' + JSON.stringify(good) + '\n```', payload).summary);
});
test('dates in AI text are not reported as invented numbers', () => {
  assert.deepStrictEqual(ai.unsupportedNumbers(['Peak at 2026-11-05T14:00:00.000Z, 14:30'], payload), []);
});
test('missing API key gives NOT_CONFIGURED (503)', async () => {
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(ai.analyze('summary', payload), (e) => e.code === 'NOT_CONFIGURED' && e.status === 503);
});
test('unknown analysis kind is rejected', async () => {
  await assert.rejects(ai.analyze('poem', payload), (e) => e.code === 'BAD_KIND');
});

// API failure handling against a fake Gemini server
const http = require('node:http');
function fake(handler) { return new Promise((ok) => { const s = http.createServer(handler).listen(0, () => ok(s)); }); }
async function withFake(handler, fn) {
  const srv = await fake(handler);
  process.env.GEMINI_API_KEY = 'test'; process.env.GEMINI_BASE_URL = 'http://127.0.0.1:' + srv.address().port; process.env.AI_TIMEOUT_MS = '500';
  try { await fn(); } finally { srv.close(); delete process.env.GEMINI_API_KEY; }
}
test('success path: key is sent in a header, answer is parsed', async () => {
  let seenKey, seenBody;
  await withFake((req, res) => { seenKey = req.headers['x-goog-api-key']; let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seenBody = b; res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] })); }); },
    async () => { const r = await ai.analyze('recommend', payload); assert.strictEqual(r.result.confidence, 'medium'); assert.strictEqual(seenKey, 'test'); assert.ok(JSON.parse(seenBody).contents[0].parts[0].text.includes('"avg":27')); });
});
test('HTTP 429 -> RATE_LIMITED', async () => {
  await withFake((req, res) => { res.statusCode = 429; res.end('{}'); }, async () => { await assert.rejects(ai.analyze('summary', payload), (e) => e.code === 'RATE_LIMITED' && e.status === 429); });
});
test('HTTP 500 -> UNAVAILABLE', async () => {
  await withFake((req, res) => { res.statusCode = 500; res.end('{}'); }, async () => { await assert.rejects(ai.analyze('summary', payload), (e) => e.code === 'UNAVAILABLE'); });
});
test('timeout -> UNAVAILABLE', async () => {
  await withFake(() => { /* never answers */ }, async () => { await assert.rejects(ai.analyze('summary', payload), (e) => e.code === 'UNAVAILABLE'); });
});
test('empty candidates -> EMPTY', async () => {
  await withFake((req, res) => res.end(JSON.stringify({ candidates: [] })), async () => { await assert.rejects(ai.analyze('summary', payload), (e) => e.code === 'EMPTY'); });
});
