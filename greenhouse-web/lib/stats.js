// Pure statistics helpers (no database, no network) so they are easy to test.
// RULE FROM THE PROJECT BRIEF: all numbers are calculated here, in application code.
// The AI only interprets numbers that this file produced.

const METRICS = ['temperature', 'humidity', 'soil_moisture'];
const UNITS = { temperature: '°C', humidity: '%', soil_moisture: '%' };
const ACTUATORS = ['fan_on', 'pump_on', 'light_on'];

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const iso = (sec) => new Date(sec * 1000).toISOString();

// rows: [{ t (epoch seconds), temperature, humidity, soil_moisture, state, fan_on, pump_on, light_on }], oldest first.

function metricStats(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number);
  if (!v.length) return { count: 0, missing: values.length, min: null, max: null, avg: null, stddev: null };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length;
  return {
    count: v.length,
    missing: values.length - v.length,
    min: round(Math.min(...v)),
    max: round(Math.max(...v)),
    avg: round(avg),
    stddev: round(Math.sqrt(variance))
  };
}

// Least-squares slope, expressed as "change per hour".
function slopePerHour(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.t, 0) / n;
  const my = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.t - mx) * (p.v - my); den += (p.t - mx) ** 2; }
  if (den === 0) return null;
  return round((num / den) * 3600, 3);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sampling(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
  const med = median(gaps);
  return {
    median_interval_s: round(med, 1),
    max_gap_s: gaps.length ? Math.max(...gaps) : null,
    gaps: gaps
  };
}

function summarize(rows) {
  const n = rows.length;
  const out = { readings: n, first_reading_at: n ? iso(rows[0].t) : null, last_reading_at: n ? iso(rows[n - 1].t) : null, metrics: {}, actuators: {}, states: {}, fault_readings: 0 };

  for (const m of METRICS) {
    const vals = rows.map((r) => r[m]);
    const s = metricStats(vals);
    const pts = rows.filter((r) => r[m] !== null && r[m] !== undefined).map((r) => ({ t: r.t, v: Number(r[m]) }));
    s.unit = UNITS[m];
    s.trend_per_hour = slopePerHour(pts);
    const half = Math.floor(pts.length / 2);
    if (pts.length >= 6) {
      const a = pts.slice(0, half).map((p) => p.v), b = pts.slice(half).map((p) => p.v);
      s.first_half_avg = round(a.reduce((x, y) => x + y, 0) / a.length);
      s.second_half_avg = round(b.reduce((x, y) => x + y, 0) / b.length);
    }
    out.metrics[m] = s;
  }

  for (const a of ACTUATORS) {
    const known = rows.filter((r) => r[a] !== null && r[a] !== undefined);
    const on = known.filter((r) => Number(r[a]) === 1 || r[a] === true).length;
    out.actuators[a.replace('_on', '')] = { samples: known.length, on_readings: on, on_percent: known.length ? round((on / known.length) * 100, 1) : null };
  }

  for (const r of rows) {
    const k = r.state || 'UNKNOWN';
    out.states[k] = (out.states[k] || 0) + 1;
  }
  for (const k of Object.keys(out.states)) out.states[k] = { count: out.states[k], percent: round((out.states[k] / n) * 100, 1) };
  out.fault_readings = out.states.FAULT ? out.states.FAULT.count : 0;

  const smp = sampling(rows);
  out.sampling = { median_interval_s: smp.median_interval_s, max_gap_s: smp.max_gap_s };
  out.sensor_dropouts = rows.filter((r) => r.temperature === null || r.soil_moisture === null).length;
  return out;
}

// Candidate anomalies found by CODE (the AI is only asked to explain them).
function detectAnomalies(rows, maxItems = 20) {
  const items = [];
  const n = rows.length;
  if (n < 10) return items;

  for (const m of METRICS) {
    const vals = rows.map((r) => r[m]).filter((v) => v !== null && v !== undefined).map(Number);
    if (vals.length < 10) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length);
    if (sd === 0) continue;
    const found = [];
    for (const r of rows) {
      if (r[m] === null || r[m] === undefined) continue;
      const z = (Number(r[m]) - avg) / sd;
      if (Math.abs(z) >= 3) found.push({ type: 'outlier', metric: m, at: iso(r.t), value: round(Number(r[m])), z_score: round(z, 1), range_avg: round(avg) });
    }
    found.sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score));
    items.push(...found.slice(0, 5));
  }

  // First reading of each FAULT run, and first reading of each sensor-dropout run.
  let inFault = false, inDrop = false;
  for (const r of rows) {
    const fault = r.state === 'FAULT';
    if (fault && !inFault) items.push({ type: 'fault_state', at: iso(r.t) });
    inFault = fault;
    const drop = r.temperature === null || r.soil_moisture === null;
    if (drop && !inDrop) items.push({ type: 'sensor_dropout', at: iso(r.t), missing: [r.temperature === null && 'temperature', r.soil_moisture === null && 'soil_moisture'].filter(Boolean) });
    inDrop = drop;
  }

  // Communication gaps (no readings for much longer than normal).
  const smp = sampling(rows);
  const limit = Math.max(smp.median_interval_s * 5, 60);
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].t - rows[i - 1].t;
    if (g > limit) items.push({ type: 'communication_gap', from: iso(rows[i - 1].t), to: iso(rows[i].t), gap_seconds: g });
  }

  items.sort((a, b) => String(a.at || a.from).localeCompare(String(b.at || b.from)));
  return items.slice(0, maxItems);
}

// Previous-period comparison: percentage-point / unit differences calculated here, not by the AI.
function compareSummaries(current, previous) {
  const diff = {};
  for (const m of METRICS) {
    const c = current.metrics[m].avg, p = previous.metrics[m].avg;
    diff[m] = { current_avg: c, previous_avg: p, change: c !== null && p !== null ? round(c - p) : null, unit: UNITS[m] };
  }
  for (const a of ['fan', 'pump', 'light']) {
    const c = current.actuators[a].on_percent, p = previous.actuators[a].on_percent;
    diff[a + '_on_percent'] = { current: c, previous: p, change_points: c !== null && p !== null ? round(c - p, 1) : null };
  }
  diff.fault_readings = { current: current.fault_readings, previous: previous.fault_readings };
  diff.readings = { current: current.readings, previous: previous.readings };
  return diff;
}

// Combine rows of several devices WITHOUT double counting: each row belongs to exactly one device.
function fleetMetrics(rowsByDevice) {
  const all = [];
  for (const rows of Object.values(rowsByDevice)) all.push(...rows);
  const out = {};
  for (const m of METRICS) { const s = metricStats(all.map((r) => r[m])); s.unit = UNITS[m]; out[m] = s; }
  return { readings: all.length, metrics: out };
}

module.exports = { METRICS, UNITS, metricStats, slopePerHour, median, summarize, detectAnomalies, compareSummaries, fleetMetrics, round };
