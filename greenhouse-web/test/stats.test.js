const test = require('node:test');
const assert = require('node:assert');
const s = require('../lib/stats');

const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ t: 1000 + i * 300, temperature: 20, humidity: 50, soil_moisture: 60, state: 'IDLE', fan_on: 0, pump_on: 0, light_on: 1, ...f(i) }));

test('metricStats ignores nulls and reports them as missing', () => {
  const m = s.metricStats([10, 20, null, 30]);
  assert.deepStrictEqual([m.count, m.missing, m.min, m.max, m.avg], [3, 1, 10, 30, 20]);
});
test('metricStats with no values does not crash', () => {
  assert.strictEqual(s.metricStats([null, null]).avg, null);
});
test('trend is slope per hour (+1 C every 5 min = +12 C/h)', () => {
  const rows = mk(10, (i) => ({ temperature: 20 + i }));
  assert.strictEqual(s.summarize(rows).metrics.temperature.trend_per_hour, 12);
});
test('summarize: actuator duty and state shares', () => {
  const rows = mk(10, (i) => ({ fan_on: i < 3 ? 1 : 0, state: i < 3 ? 'COOLING' : 'IDLE' }));
  const r = s.summarize(rows);
  assert.strictEqual(r.actuators.fan.on_percent, 30);
  assert.strictEqual(r.states.COOLING.count, 3);
});
test('detectAnomalies finds a spike, a sensor dropout, a FAULT run and a comms gap', () => {
  const rows = mk(60, (i) => ({ temperature: i === 20 ? 60 : 22 + (i % 3) * 0.1 }));
  rows[40].temperature = null; rows[40].state = 'FAULT';
  rows.splice(50, 8);                                   // 8 missing readings = 45 min gap
  const types = s.detectAnomalies(rows).map((a) => a.type);
  for (const t of ['outlier', 'sensor_dropout', 'fault_state', 'communication_gap']) assert.ok(types.includes(t), t);
});
test('detectAnomalies returns nothing for too little data', () => {
  assert.deepStrictEqual(s.detectAnomalies(mk(5, () => ({}))), []);
});
test('fleetMetrics counts every reading once and keeps metrics separate', () => {
  const f = s.fleetMetrics({ 1: mk(10, () => ({ temperature: 20 })), 2: mk(10, () => ({ temperature: 30 })) });
  assert.strictEqual(f.readings, 20);
  assert.strictEqual(f.metrics.temperature.avg, 25);
  assert.strictEqual(f.metrics.humidity.avg, 50);
});
test('compareSummaries reports differences', () => {
  const a = s.summarize(mk(10, () => ({ temperature: 30 }))), b = s.summarize(mk(10, () => ({ temperature: 25 })));
  assert.strictEqual(s.compareSummaries(a, b).temperature.change, 5);
});
