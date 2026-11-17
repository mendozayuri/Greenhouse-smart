/* Smart Greenhouse front end. Plain JavaScript, no build step.
   All permissions are enforced by the server; this file only decides what to show. */
(() => {
'use strict';

// ---------- Small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 1) => (v === null || v === undefined || v === '' ? '--' : Number(v).toFixed(d));
const onoff = (v) => (v === null || v === undefined ? '--' : v ? 'ON' : 'OFF');
const fmtDT = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '--');
const fmtTimeS = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '--');
function fmtAge(s) {
  if (s === null || s === undefined) return 'never';
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
  return Math.floor(s / 86400) + ' d';
}

const METRICS = {
  temperature: { label: 'Temperature', unit: '°C', color: '#1b5e20', d: 1 },
  humidity: { label: 'Humidity', unit: '%', color: '#43a047', d: 0 },
  soil_moisture: { label: 'Soil moisture', unit: '%', color: '#81c784', d: 0 }
};
const DEV_COLORS = ['#1b5e20', '#66bb6a', '#2e7d32', '#a5d6a7', '#33691e', '#9e9e9e'];

const S = { token: sessionStorage.getItem('token'), user: null, devices: [], deviceId: null, preset: '24h', from: null, to: null, view: null, timers: [], charts: {}, suggest: null };

// ---------- API ----------
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch {
    const e = new Error('Cannot reach the server. Check your connection and try again.'); e.network = true; throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'Request failed (' + res.status + ')');
    e.status = res.status; e.data = data; e.code = data.code;
    if (res.status === 401 && S.token) { logout('Your session expired. Please log in again.'); }
    throw e;
  }
  return data;
}

function banner(msg, kind = 'bad') { $('#banner').innerHTML = msg ? `<div class="note ${kind}" role="alert">${esc(msg)}</div>` : ''; }
function failure(e) { banner(e.message, e.network ? 'warn' : 'bad'); }

// ---------- Landing / login ----------
let registering = false;
function setMode(reg) {
  registering = reg;
  $('#tabLogin').setAttribute('aria-selected', String(!reg)); $('#tabRegister').setAttribute('aria-selected', String(reg));
  $('#authSubmit').textContent = reg ? 'Create account' : 'Log in';
  $('#pwHint').classList.toggle('hidden', !reg);
  $('#roleBox').classList.toggle('hidden', !reg);
  if (reg) loadSlots();
  $('#password').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authMsg').textContent = ''; $('#authMsg').className = 'error';
}
async function loadSlots() {
  try {
    const s = await api('/api/register/slots');
    const sel = $('#role');
    sel.options[0].textContent = `User (${s.users_left} of ${s.max_users} places left)`; sel.options[0].disabled = s.users_left === 0;
    sel.options[1].textContent = `Administrator (${s.admins_left} of ${s.max_admins} places left)`; sel.options[1].disabled = s.admins_left === 0;
    if (sel.options[sel.selectedIndex].disabled) sel.value = s.users_left ? 'user' : s.admins_left ? 'admin' : 'user';
  } catch { /* the register request will show the error */ }
}
$('#tabLogin').onclick = () => setMode(false);
$('#tabRegister').onclick = () => setMode(true);

$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('#authMsg'); msg.textContent = ''; msg.className = 'error';
  const body = { email: $('#email').value.trim(), password: $('#password').value };
  if (registering) body.role = $('#role').value;
  if (!body.email || !body.password) { msg.textContent = 'Enter your email and password.'; return; }
  $('#authSubmit').disabled = true;
  try {
    if (registering) {
      await api('/api/register', { method: 'POST', body });
      const d = await api('/api/login', { method: 'POST', body });      // log in straight after registering
      S.token = d.token; sessionStorage.setItem('token', d.token);
      await startApp();
    } else {
      const d = await api('/api/login', { method: 'POST', body });
      S.token = d.token; sessionStorage.setItem('token', d.token);
      await startApp();
    }
  } catch (err) { msg.textContent = err.message; }
  finally { $('#authSubmit').disabled = false; }
};

function logout(message) {
  sessionStorage.removeItem('token'); S.token = null; S.user = null; S.devices = [];
  clearTimers(); destroyCharts();
  $('#app').classList.add('hidden'); $('#landing').classList.remove('hidden');
  $('#password').value = '';
  if (message) { $('#authMsg').className = 'error'; $('#authMsg').textContent = message; }
  history.replaceState(null, '', location.pathname);
}
$('#logout').onclick = () => logout();

// ---------- Navigation ----------
const isAdmin = () => S.user && S.user.role === 'admin';
function navItems() {
  const mine = S.devices.length ? [['dash', 'Dashboard'], ['analytics', 'Analytics'], ['settings', 'Settings']] : [];
  if (!isAdmin()) return mine.length ? mine : [['dash', 'Dashboard']];
  const adm = [['a-overview', 'Overview'], ['a-monitor', 'Monitoring'], ['a-analytics', 'System analytics'], ['a-devices', 'Devices & rules'], ['a-users', 'Users'], ['a-activity', 'Activity']];
  return [...adm, ...mine.map(([k, l]) => [k, 'My ' + l.toLowerCase()])];
}
function renderNav() {
  $('#nav').innerHTML = navItems().map(([k, l]) => `<a href="#/${k}" ${S.view === k ? 'aria-current="page"' : ''}>${esc(l)}</a>`).join('');
}
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }
function every(ms, fn) { S.timers.push(setInterval(fn, ms)); }
function destroyCharts() { Object.values(S.charts).forEach((c) => c.destroy()); S.charts = {}; }

const VIEWS = {};
async function go() {
  if (!S.user) return;
  const want = (location.hash.replace('#/', '') || '').trim();
  const allowed = navItems().map(([k]) => k);
  const view = allowed.includes(want) ? want : allowed[0];
  clearTimers(); destroyCharts(); banner('');
  S.view = view; renderNav();
  $('#view').innerHTML = '<p class="muted"><span class="spinner"></span>Loading…</p>';
  try { await VIEWS[view](); } catch (e) { failure(e); if (!$('#view').children.length || $('#view .spinner')) $('#view').innerHTML = '<div class="empty">This page could not be loaded.</div>'; }
}
window.addEventListener('hashchange', go);

async function startApp() {
  try {
    S.user = await api('/api/me');
    S.devices = await api('/api/my/devices');
  } catch (e) { logout(e.message); return; }
  S.deviceId = S.devices.length ? S.devices[0].id : null;
  $('#landing').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = `${S.user.email} · ${S.user.role}`;
  if (!location.hash.startsWith('#/')) location.hash = '#/' + navItems()[0][0];
  go();
}

// ---------- Shared UI parts ----------
const bounds = () => {
  const hrs = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[S.preset];
  if (hrs) { const now = Date.now(); return { from: new Date(now - hrs * 3600e3), to: new Date(now) }; }
  return { from: new Date(S.from), to: new Date(S.to) };
};
const rq = () => { const r = bounds(); return `from=${encodeURIComponent(r.from.toISOString())}&to=${encodeURIComponent(r.to.toISOString())}`; };
const toLocalInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function rangeControls(extra = '') {
  const presets = ['1h', '6h', '24h', '7d', '30d'];
  const r = bounds();
  return `<div class="range">
    <div><label>Time range</label><div class="seg" role="group" aria-label="Time range">${presets.map((p) => `<button data-act="preset" data-v="${p}" aria-pressed="${S.preset === p}">${p}</button>`).join('')}<button data-act="preset" data-v="custom" aria-pressed="${S.preset === 'custom'}">Custom</button></div></div>
    <div><label for="rFrom">From</label><input id="rFrom" type="datetime-local" value="${toLocalInput(r.from)}"></div>
    <div><label for="rTo">To</label><input id="rTo" type="datetime-local" value="${toLocalInput(r.to)}"></div>
    <button class="btn sm" data-act="apply-range" style="align-self:end">Apply</button>${extra}</div>`;
}

function statusChip(dev, staleAfter) {
  if (!dev || dev.age_seconds === null || dev.age_seconds === undefined) return '<span class="chip plain">No data yet</span>';
  return dev.age_seconds <= staleAfter
    ? `<span class="chip ok">Live · updated ${fmtAge(dev.age_seconds)} ago</span>`
    : `<span class="chip warn">Stale · last data ${fmtAge(dev.age_seconds)} ago</span>`;
}
const stateChip = (s) => `<span class="chip ${s === 'FAULT' ? 'bad' : s === 'IDLE' ? 'ok' : s ? 'info' : 'plain'}">${esc(s || 'unknown')}</span>`;

function deviceSelect() {
  if (S.devices.length < 2) return S.devices[0] ? `<span class="muted">${esc(S.devices[0].name)}</span>` : '';
  return `<label class="small muted" for="devSel">Greenhouse</label><select id="devSel" style="width:auto">${S.devices.map((d) => `<option value="${d.id}" ${d.id === S.deviceId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
}

function emptyNoDevice() {
  $('#view').innerHTML = `<div class="card empty"><h3>No greenhouse assigned yet</h3><p>An administrator needs to assign a greenhouse to your account. Once they do, log in again to see your readings.</p></div>`;
}

// Draws one line chart. Gaps (missing buckets or null values) are shown as breaks, never joined.
function drawChart(id, datasets, unit, bucketMs) {
  const el = document.getElementById(id); if (!el) return;
  if (!window.Chart) { el.parentElement.innerHTML = '<div class="empty small">Charts could not load (offline?). The numbers below are still correct.</div>'; return; }
  if (S.charts[id]) S.charts[id].destroy();
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim();
  const r = bounds(), span = r.to - r.from;
  const tickFmt = (v) => { const d = new Date(v); return span <= 36 * 3600e3 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit' }); };
  S.charts[id] = new Chart(el, {
    type: 'line',
    data: { datasets: datasets.map((ds) => ({ ...ds, data: withGaps(ds.points, bucketMs), parsing: false, borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.25, spanGaps: false })) },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, parsing: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'linear', min: r.from.getTime(), max: r.to.getTime(), ticks: { callback: tickFmt, color: muted, maxTicksLimit: 6 }, grid: { color: line } },
        y: { title: { display: true, text: unit, color: muted }, ticks: { color: muted }, grid: { color: line } }
      },
      plugins: { legend: { display: datasets.length > 1, labels: { color: muted } }, tooltip: { callbacks: { title: (it) => fmtTimeS(it[0].parsed.x) } } }
    }
  });
}
function withGaps(points, bucketMs) {
  const out = [];
  points.forEach((p, i) => {
    if (i && bucketMs && p.x - points[i - 1].x > bucketMs * 3) out.push({ x: points[i - 1].x + bucketMs, y: null });
    out.push(p);
  });
  return out;
}
function chartCard(id, title) { return `<div class="card"><h3>${esc(title)}</h3><div class="chartbox"><canvas id="${id}" role="img" aria-label="${esc(title)} over time"></canvas></div></div>`; }

function drawMetricCharts(seriesList, bucketSeconds) {
  // seriesList: [{name, points:[{t, temperature, humidity, soil_moisture}]}]  -> one chart per measurement (units differ, so never combined)
  for (const [m, meta] of Object.entries(METRICS)) {
    drawChart('ch-' + m, seriesList.map((s, i) => ({
      label: s.name, borderColor: seriesList.length > 1 ? DEV_COLORS[i % DEV_COLORS.length] : meta.color,
      points: s.points.map((p) => ({ x: p.t, y: p[m] }))
    })), `${meta.label} (${meta.unit})`, bucketSeconds * 1000);
  }
}
const metricChartsHtml = () => `<div class="grid g3">${Object.entries(METRICS).map(([m, meta]) => chartCard('ch-' + m, meta.label + ' (' + meta.unit + ')')).join('')}</div>`;

// ---------- Dialog forms ----------
function openForm({ title, intro, fields, submit = 'Save', onSubmit }) {
  const d = $('#dlg');
  const f = (x) => x.type === 'select'
    ? `<label class="field"><span>${esc(x.label)}</span><select name="${x.name}">${x.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(x.value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`
    : x.type === 'checkbox'
      ? `<label class="field"><input type="checkbox" name="${x.name}" ${x.value ? 'checked' : ''}> ${esc(x.label)}</label>`
      : `<label class="field"><span>${esc(x.label)}</span><input name="${x.name}" type="${x.type || 'text'}" value="${esc(x.value ?? '')}" ${x.min !== undefined ? `min="${x.min}"` : ''} ${x.max !== undefined ? `max="${x.max}"` : ''} step="${x.step || 'any'}" ${x.maxlength ? `maxlength="${x.maxlength}"` : ''} required></label>`;
  d.innerHTML = `<form class="dform"><h3>${esc(title)}</h3>${intro ? `<p class="muted small">${esc(intro)}</p>` : ''}${fields.map(f).join('')}<p class="error" id="dlgErr" role="alert"></p><div class="row end"><button type="button" class="btn ghost" data-act="dlg-close">Cancel</button><button class="btn" type="submit">${esc(submit)}</button></div></form>`;
  const form = $('form', d);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    fields.filter((x) => x.type === 'checkbox').forEach((x) => { data[x.name] = form.elements[x.name].checked; });
    try { await onSubmit(data); d.close(); } catch (err) { $('#dlgErr').textContent = err.message; }
  };
  d.showModal();
}
function showKey(title, name, key) {
  const d = $('#dlg');
  d.innerHTML = `<h3>${esc(title)}</h3><p>Device key for <b>${esc(name)}</b>. Copy it into the ESP32 code now. It will not be shown again.</p><div class="keybox">${esc(key)}</div><div class="row end" style="margin-top:14px"><button class="btn" data-act="dlg-close">Done</button></div>`;
  d.showModal();
}

// ---------- Event delegation for all buttons ----------
const ACT = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.preventDefault(); Promise.resolve(ACT[el.dataset.act](el, e)).catch(failure); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'devSel') { S.deviceId = Number(e.target.value); go(); }
});
ACT['dlg-close'] = () => $('#dlg').close();
ACT.preset = (el) => {
  S.preset = el.dataset.v;
  if (S.preset === 'custom') { const r = bounds(); S.from = $('#rFrom') ? $('#rFrom').value : toLocalInput(r.from); S.to = $('#rTo') ? $('#rTo').value : toLocalInput(r.to); }
  go();
};
ACT['apply-range'] = () => {
  const f = $('#rFrom').value, t = $('#rTo').value;
  if (!f || !t || new Date(f) >= new Date(t)) { banner('Choose a start that is before the end.'); return; }
  S.preset = 'custom'; S.from = f; S.to = t; go();
};

// =====================================================================
//  USER VIEWS
// =====================================================================
VIEWS.dash = async () => {
  if (!S.devices.length) return emptyNoDevice();
  $('#view').innerHTML = `
    <div class="pagehead"><div><h2>Dashboard</h2><div class="row">${deviceSelect()}<span id="status"></span></div></div></div>
    <div id="staleNote"></div><div class="tiles" id="tiles"></div>
    ${rangeControls()}${metricChartsHtml()}
    <div class="grid g2"><div class="card"><h3>Recent alerts</h3><div id="alerts"></div></div>
    <div class="card"><h3>Latest readings</h3><div class="tablewrap" id="readings"></div></div></div>`;
  await refreshDash(true);
  every(5000, () => refreshDash(false));
  every(30000, () => refreshDash(true));
};

async function refreshDash(withCharts) {
  const id = S.deviceId;
  try {
    const ov = await api('/api/my/overview?device_id=' + id);
    if (S.view !== 'dash') return;
    banner('');
    renderOverview(ov);
    if (withCharts) {
      const [ser, rows] = await Promise.all([api(`/api/my/series?device_id=${id}&${rq()}`), api(`/api/my/readings?device_id=${id}&limit=12&${rq()}`)]);
      if (S.view !== 'dash') return;
      drawMetricCharts([{ name: ov.device.name, points: ser.points }], ser.bucket_seconds);
      $('#readings').innerHTML = rows.length
        ? `<table><thead><tr><th>Time</th><th class="num">°C</th><th class="num">Hum %</th><th class="num">Soil %</th><th>State</th><th>Fan</th><th>Pump</th></tr></thead><tbody>${rows.slice().reverse().map((r) => `<tr><td>${fmtTimeS(r.created_at)}</td><td class="num">${fmt(r.temperature)}</td><td class="num">${fmt(r.humidity, 0)}</td><td class="num">${fmt(r.soil_moisture, 0)}</td><td>${esc(r.state || '--')}</td><td>${onoff(r.fan_on)}</td><td>${onoff(r.pump_on)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty small">No readings in this time range.</div>';
    }
  } catch (e) { failure(e); }
}

function renderOverview(ov) {
  const stale = ov.device.age_seconds === null || ov.device.age_seconds > ov.stale_after_seconds;
  $('#status').innerHTML = statusChip(ov.device, ov.stale_after_seconds);
  $('#staleNote').innerHTML = ov.latest && stale ? `<div class="note warn">This device has not sent data for ${fmtAge(ov.device.age_seconds)}. The values below are the last ones received and may be out of date.</div>`
    : !ov.latest ? '<div class="note info">No readings yet. Waiting for the greenhouse to send data…</div>' : '';
  const l = ov.latest || {};
  const tile = (k, v, u) => `<div class="tile ${stale ? 'stale' : ''}"><div class="k">${k}</div><div class="v">${v}${u ? ` <small>${u}</small>` : ''}</div></div>`;
  $('#tiles').innerHTML = tile('Temperature', fmt(l.temperature), '°C') + tile('Humidity', fmt(l.humidity, 0), '%') + tile('Soil moisture', fmt(l.soil_moisture, 0), '%')
    + `<div class="tile ${stale ? 'stale' : ''}"><div class="k">State</div><div class="v" style="font-size:1.2rem;padding-top:6px">${stateChip(l.state)}</div></div>`
    + tile('Fan', onoff(l.fan_on), '') + tile('Pump', onoff(l.pump_on), '') + tile('Light', onoff(l.light_on), '');
  if (l.temperature === null && ov.latest) $('#tiles').insertAdjacentHTML('beforebegin', '<div class="note bad">Temperature sensor is not reporting. The device is protecting itself (see state).</div>');
  $('#alerts').innerHTML = ov.alerts.length
    ? `<ul class="list">${ov.alerts.map((a) => `<li><span><span class="sev-${esc(a.severity)}">${esc(a.severity)}</span> · ${esc(a.message)}</span><span class="muted small">${fmtDT(a.created_at)}</span></li>`).join('')}</ul>`
    : '<div class="empty small">No alerts. All good.</div>';
}

// ----- user analytics -----
const AI_BUTTONS = [['summary', 'Summarize trends'], ['anomalies', 'Explain anomalies'], ['compare', 'Compare with previous period'], ['recommend', 'Recommend adjustments']];
function aiPanel(scopeNote) {
  return `<div class="card"><h3>AI insights</h3>
    <p class="muted small">${esc(scopeNote)} The AI only explains numbers that this server calculated from the stored readings. Generated on request, saved results are reused for identical data. Suggestions are never applied automatically.</p>
    <div class="row">${AI_BUTTONS.map(([k, l]) => `<button class="btn ghost" data-act="ai" data-kind="${k}">${esc(l)}</button>`).join('')}</div>
    <div id="aiOut" aria-live="polite" style="margin-top:14px"></div></div>`;
}

VIEWS.analytics = async () => {
  if (!S.devices.length) return emptyNoDevice();
  $('#view').innerHTML = `<div class="pagehead"><div><h2>Analytics</h2><div class="row">${deviceSelect()}</div></div></div>${rangeControls()}<div id="scope" class="note info"></div>${metricChartsHtml()}<div id="statsOut"></div>${aiPanel('Based on your selected greenhouse and time range.')}`;
  const id = S.deviceId;
  const [bundle, ser] = await Promise.all([api(`/api/my/analytics?device_id=${id}&${rq()}`), api(`/api/my/series?device_id=${id}&${rq()}`)]);
  $('#scope').innerHTML = scopeLine(bundle, 'Your greenhouse');
  drawMetricCharts([{ name: bundle.devices[0].name, points: ser.points }], ser.bucket_seconds);
  $('#statsOut').innerHTML = bundle.devices.map((d) => deviceStatsCard(d)).join('');
};

function scopeLine(bundle, who) {
  const names = bundle.devices.map((d) => d.name).join(', ') || 'none';
  return `<b>Scope:</b> ${esc(who)} · ${esc(names)} &nbsp;·&nbsp; <b>Range:</b> ${fmtDT(bundle.range.from)} → ${fmtDT(bundle.range.to)}`;
}

function statsTable(st) {
  const rows = Object.entries(METRICS).map(([m, meta]) => {
    const x = st.metrics[m]; const trend = x.trend_per_hour === null || x.trend_per_hour === undefined ? '--' : (x.trend_per_hour > 0 ? '+' : '') + x.trend_per_hour + ' ' + meta.unit + '/h';
    return `<tr><td>${meta.label} (${meta.unit})</td><td class="num">${x.count}</td><td class="num">${x.missing}</td><td class="num">${fmt(x.min, 1)}</td><td class="num">${fmt(x.avg, 1)}</td><td class="num">${fmt(x.max, 1)}</td><td class="num">${fmt(x.stddev, 1)}</td><td class="num">${trend}</td></tr>`;
  }).join('');
  return `<div class="tablewrap"><table><thead><tr><th>Measurement</th><th class="num">Readings</th><th class="num">Missing</th><th class="num">Min</th><th class="num">Avg</th><th class="num">Max</th><th class="num">Std dev</th><th class="num">Trend</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function actuatorsLine(st) {
  const a = st.actuators;
  const states = Object.entries(st.states).map(([k, v]) => `${esc(k)} ${v.percent}%`).join(' · ') || '--';
  return `<p class="small muted" style="margin-top:10px">Share of readings with the output ON: fan <b>${fmt(a.fan.on_percent)}%</b> · pump <b>${fmt(a.pump.on_percent)}%</b> · light <b>${fmt(a.light.on_percent)}%</b>. &nbsp;States: ${states}. &nbsp;Median interval between readings: ${st.sampling.median_interval_s ?? '--'} s, longest gap: ${st.sampling.max_gap_s ?? '--'} s.</p>`;
}
function anomalyList(items) {
  if (!items || !items.length) return '<p class="small muted">No anomalies detected by the rules (|z| ≥ 3, FAULT state, sensor dropout, communication gap).</p>';
  const t = (a) => a.type === 'outlier' ? `${esc(METRICS[a.metric].label)} outlier ${a.value} ${METRICS[a.metric].unit} (z = ${a.z_score}; range average ${a.range_avg})`
    : a.type === 'fault_state' ? 'Device entered FAULT state' : a.type === 'sensor_dropout' ? 'Sensor dropout: ' + esc(a.missing.join(', '))
      : `Communication gap of ${fmtAge(a.gap_seconds)}`;
  return `<ul class="list">${items.map((a) => `<li><span>${t(a)}</span><span class="muted small">${fmtDT(a.at || a.from)}</span></li>`).join('')}</ul>`;
}
function deviceStatsCard(d) {
  const m = d.measured, alerts = Object.entries(m.alerts_in_range).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  if (!d.stats.readings) return `<div class="card"><h3>${esc(d.name)}</h3><div class="empty small">No readings in this time range.</div></div>`;
  return `<div class="card"><h3>${esc(d.name)} · calculated statistics</h3>${m.truncated ? '<div class="note warn small">Very large range: statistics use the newest 50,000 readings.</div>' : ''}
    ${statsTable(d.stats)}${actuatorsLine(d.stats)}<p class="small muted">Alerts in range: ${esc(alerts)}.</p><h4 style="margin-top:12px">Anomalies detected by the system</h4>${anomalyList(d.anomalies_detected_by_code)}</div>`;
}

// ----- AI result rendering (facts / statistics / AI opinion are kept apart) -----
function renderAi(res, canApply) {
  const a = res.ai;
  const facts = res.devices.map((d) => {
    const l = d.measured.latest_reading;
    return `<li><span><b>${esc(d.name)}</b>: ${d.measured.readings_in_range} readings stored in range${l ? `; latest ${fmtDT(l.at)}: ${fmt(l.temperature)} °C, ${fmt(l.humidity, 0)} % humidity, ${fmt(l.soil_moisture, 0)} % soil, state ${esc(l.state || '--')}` : ''}.</span></li>`;
  }).join('');
  const act = res.recorded_user_actions && Object.keys(res.recorded_user_actions).length
    ? `<li><span>Recorded user actions in range: ${Object.entries(res.recorded_user_actions).map(([k, v]) => `${esc(k)} ${v}`).join(', ')}.</span></li>` : '';
  const calc = res.devices.map((d) => d.stats.readings ? `<h4 style="margin-top:8px">${esc(d.name)}</h4>${statsTable(d.stats)}${actuatorsLine(d.stats)}
      ${d.comparison_calculated_by_code ? `<p class="small"><b>Compared with the previous period (same length):</b> ${Object.entries(METRICS).map(([m, meta]) => { const c = d.comparison_calculated_by_code[m]; return `${meta.label} avg ${fmt(c.current_avg)} vs ${fmt(c.previous_avg)} ${meta.unit} (${c.change === null ? '--' : (c.change > 0 ? '+' : '') + c.change})`; }).join('; ')}.</p>` : ''}
      <p class="small" style="margin:6px 0 2px"><b>Anomalies found by code</b></p>${anomalyList(d.anomalies_detected_by_code)}` : '').join('');
  const fleet = res.fleet_metrics_all_readings_counted_once;
  const fleetHtml = fleet ? `<p class="small muted" style="margin-top:8px">All devices together (each reading counted once, ${fleet.readings} readings; measurements kept separate): ${Object.entries(METRICS).map(([m, meta]) => `${meta.label} avg ${fmt(fleet.metrics[m].avg)} ${meta.unit}`).join(' · ')}.</p>` : '';
  const warn = (a.warnings || []).map((w) => `<div class="note warn small">Note: ${esc(w)}</div>`).join('');
  const conf = `<span class="chip ${a.confidence === 'high' ? 'ok' : a.confidence === 'medium' ? 'info' : 'warn'} plain">AI confidence: ${esc(a.confidence)}</span>`;
  return `<article class="ai-result">
    <div class="ai-meta"><b>Scope:</b> ${esc(res.scope.type)} (${esc(res.devices.map((d) => d.name).join(', ') || 'no devices')}) · <b>Analysed range:</b> ${fmtDT(res.range.from)} → ${fmtDT(res.range.to)} · <b>Generated:</b> ${fmtTimeS(res.generated_at)} · <b>Type:</b> ${esc(res.kind)} · model ${esc(res.ai_model || '--')}${res.cached ? ' · <span class="chip info plain">saved result, data unchanged</span>' : ''}</div>
    <section class="layer facts"><h4><span class="tag t-fact">Measured</span>Recorded by the sensors</h4><ul class="list">${facts}${act}</ul></section>
    <section class="layer calc"><h4><span class="tag t-calc">Calculated</span>Computed by the server from stored readings</h4>${calc}${fleetHtml}</section>
    <section class="layer ai"><h4><span class="tag t-ai">AI interpretation</span>Opinion based on the numbers above</h4>
      ${warn}<p>${esc(a.summary)}</p>
      ${a.findings.length ? '<h4>Findings</h4>' + a.findings.map((f) => `<div class="finding">${esc(f.text)} ${f.evidence ? `<code class="ev">${esc(f.evidence)}</code>` : ''}</div>`).join('') : ''}
      ${a.recommendations.length ? '<h4 style="margin-top:10px">Suggestions (for you to review)</h4>' + a.recommendations.map((r) => `<div class="rec">${esc(r.text)} ${r.evidence ? `<code class="ev">${esc(r.evidence)}</code>` : ''}
          ${r.setting && canApply ? `<div style="margin-top:6px"><button class="btn sm ghost" data-act="review-setting" data-setting="${esc(r.setting)}" data-value="${esc(r.suggested_value)}">Review in settings: ${esc(r.setting)} → ${esc(r.suggested_value)}</button></div>` : r.setting ? `<div class="small muted" style="margin-top:4px">Suggested setting: ${esc(r.setting)} → ${esc(r.suggested_value)}</div>` : ''}</div>`).join('') : ''}
      <p class="small muted" style="margin-top:10px">${conf} ${a.limitations ? ' Limitations: ' + esc(a.limitations) : ''}</p>
    </section></article>`;
}

function renderAiError(e) {
  const kind = e.code === 'INSUFFICIENT_DATA' ? 'info' : e.code === 'RATE_LIMITED' || e.code === 'LIMIT' || e.code === 'COOLDOWN' ? 'warn' : 'bad';
  return `<div class="note ${kind}"><b>${e.code === 'INSUFFICIENT_DATA' ? 'Not enough data' : 'AI analysis unavailable'}.</b> ${esc(e.message)}${e.code === 'INSUFFICIENT_DATA' ? '' : ' The calculated statistics on this page are not affected.'}</div>`;
}

async function runAi(el, url, body, canApply) {
  const out = $('#aiOut'); const btns = document.querySelectorAll('[data-act=ai]');
  btns.forEach((b) => (b.disabled = true));
  out.innerHTML = `<p class="muted"><span class="spinner"></span>Analysing the stored readings… this can take up to 30 seconds.</p>`;
  try { const res = await api(url, { method: 'POST', body: { ...body, kind: el.dataset.kind } }); out.innerHTML = renderAi(res, canApply); out.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  catch (e) { out.innerHTML = renderAiError(e); }
  finally { btns.forEach((b) => (b.disabled = false)); }
}
ACT.ai = (el) => {
  const r = bounds();
  if (S.view === 'a-analytics') {
    return runAi(el, '/api/admin/ai', { from: r.from.toISOString(), to: r.to.toISOString(), user_id: A.userId ? Number(A.userId) : undefined, device_id: A.deviceId ? Number(A.deviceId) : undefined }, false);
  }
  return runAi(el, '/api/my/ai', { device_id: S.deviceId, from: r.from.toISOString(), to: r.to.toISOString() }, true);
};
ACT['review-setting'] = (el) => { S.suggest = { setting: el.dataset.setting, value: Number(el.dataset.value) }; location.hash = '#/settings'; };

// ----- user settings -----
const LIMITS = { temp_on: [10, 50], temp_off: [5, 49], soil_low: [5, 90] };
VIEWS.settings = async () => {
  if (!S.devices.length) return emptyNoDevice();
  const id = S.deviceId;
  const [ov, rules] = await Promise.all([api('/api/my/overview?device_id=' + id), api('/api/my/rules?device_id=' + id)]);
  const s = ov.settings, sg = S.suggest; S.suggest = null;
  const v = (k) => (sg && sg.setting === k ? sg.value : s[k]);
  const fld = (k, label, hint) => `<label class="field"><span>${label} <small>(${LIMITS[k][0]}–${LIMITS[k][1]})</small></span><input name="${k}" type="number" step="0.5" min="${LIMITS[k][0]}" max="${LIMITS[k][1]}" value="${v(k)}" required ${sg && sg.setting === k ? 'style="border-color:var(--sun);border-width:2px"' : ''}><small class="muted">${hint}</small></label>`;
  $('#view').innerHTML = `<div class="pagehead"><div><h2>Device settings</h2><div class="row">${deviceSelect()}<span id="status">${statusChip(ov.device, ov.stale_after_seconds)}</span></div></div></div>
    <div class="grid g2"><div class="card"><h3>Thresholds</h3>
      ${sg ? `<div class="note warn">AI suggestion loaded into the form (${esc(sg.setting)} → ${esc(sg.value)}). Nothing has been changed yet: review it and press Save to send it to the device.</div>` : ''}
      <form id="setForm" novalidate>
        ${fld('temp_on', 'Fan ON above (°C)', 'The fan starts when the temperature reaches this value.')}
        ${fld('temp_off', 'Fan OFF below (°C)', 'The fan stops at this value. Must be at least 1 °C lower than the ON value.')}
        ${fld('soil_low', 'Pump ON below soil moisture (%)', 'The pump waters when the soil is drier than this.')}
        <button class="btn" type="submit">Save and send to device</button><p class="error" id="setErr" role="alert"></p>
      </form></div>
      <div class="card"><h3>Device confirmation</h3><div id="ack"></div>
        <h3 style="margin-top:18px">Alert rules on this greenhouse</h3>
        ${rules.length ? `<ul class="list">${rules.map((r) => `<li><span>${esc(r.message)}: ${esc(r.metric.replace('_', ' '))} ${esc(r.operator)} ${esc(r.threshold)}</span><span class="chip plain ${r.enabled ? 'ok' : ''}">${r.enabled ? 'on' : 'off'}</span></li>`).join('')}</ul>` : '<p class="muted small">No alert rules yet. An administrator can add them.</p>'}
        <p class="muted small">Safety protection (FAULT state, sensor failure handling) runs on the device itself and does not depend on this website or on AI.</p></div>
      <div class="card"><h3>Pump control</h3><div id="pump"></div></div></div>`;
  renderAck(s, ov.device, ov.stale_after_seconds);
  renderPump(ov.pump_command, ov.device, ov.stale_after_seconds, s.soil_low, ov.latest);
  $('#setForm').onsubmit = async (e) => {
    e.preventDefault(); $('#setErr').textContent = '';
    const body = Object.fromEntries(new FormData(e.target)); body.device_id = id;
    try {
      const r = await api('/api/my/settings', { method: 'PUT', body });
      renderAck(r.settings, ov.device, ov.stale_after_seconds, r.changed ? 'Saved. Waiting for the device to confirm…' : 'Nothing changed: these are already the current settings.');
    } catch (err) { $('#setErr').textContent = err.message; }
  };
  every(3000, async () => { try { const o = await api('/api/my/overview?device_id=' + id); $('#status').innerHTML = statusChip(o.device, o.stale_after_seconds); renderAck(o.settings, o.device, o.stale_after_seconds); renderPump(o.pump_command, o.device, o.stale_after_seconds, o.settings.soil_low, o.latest); } catch (e) { failure(e); } });
};
function renderPump(cmd, dev, staleAfter, soilLow, latest) {
  const el = $('#pump'); if (!el) return;
  if (el.dataset.busy === '1') return;                       // do not redraw while a request is in flight
  const offline = dev.age_seconds === null || dev.age_seconds > staleAfter;
  const waiting = !!cmd && (cmd.status === 'pending' || cmd.status === 'sent');
  const pumpIsOn = !!(latest && latest.pump_on) && !offline;
  const chips = { pending: ['warn', 'Waiting for device'], sent: ['warn', 'Device received it'], done: ['ok', 'Acknowledged'], rejected: ['bad', 'Rejected by device'], expired: ['bad', 'Not delivered'] };
  const c = cmd ? (chips[cmd.status] || ['plain', cmd.status]) : null;
  const what = cmd ? (cmd.action === 'pump_off' ? 'Pump OFF' : 'Pump ON') : '';
  const now = offline ? '<span class="chip warn">Unknown (device offline)</span>' : pumpIsOn ? '<span class="chip ok">ON</span>' : '<span class="chip plain">OFF</span>';
  el.innerHTML = `<p>Pump right now: ${now}</p>
    <div class="row">
      <button class="btn" id="pumpOnBtn" type="button" ${offline || waiting ? 'disabled' : ''}>Pump ON</button>
      <button class="btn ghost" id="pumpOffBtn" type="button" ${offline ? 'disabled' : ''}>Pump OFF</button>
    </div>
    <p class="small muted" style="margin-top:10px">Pump ON keeps the pump running until you press Pump OFF. As a safety limit the device switches it off by itself after 60 seconds, if it loses contact with this website, or if a sensor fault appears. The pump also still waters on its own whenever the soil drops below ${esc(soilLow)} %.</p>
    ${offline ? '<p class="small"><span class="chip warn">Device offline</span> Commands cannot be sent until the device reports in again.</p>' : ''}
    <p class="error" id="pumpErr" role="alert">${esc(el.dataset.err || '')}</p>
    ${cmd ? `<p style="margin-top:12px"><strong>${what}</strong> <span class="chip ${c[0]}">${c[1]}</span></p><p class="small muted">Command #${cmd.id} by ${esc(cmd.requested_by || 'unknown')} at ${fmtTimeS(cmd.requested_at)}${cmd.acked_at ? ' · confirmed at ' + fmtTimeS(cmd.acked_at) : ''}${cmd.result ? '. ' + esc(cmd.result) : ''}.</p>` : '<p class="small muted" style="margin-top:12px">No manual pump command sent yet.</p>'}`;
  const send = async (action) => {
    el.dataset.busy = '1'; el.dataset.err = '';
    $('#pumpOnBtn').disabled = true; $('#pumpOffBtn').disabled = true; $('#pumpErr').textContent = '';
    try {
      await api('/api/my/pump', { method: 'POST', body: { device_id: S.deviceId, action } });
    } catch (err) { el.dataset.err = err.message; }
    el.dataset.busy = '0';
    try {
      const o = await api('/api/my/overview?device_id=' + S.deviceId);
      renderPump(o.pump_command, o.device, o.stale_after_seconds, o.settings.soil_low, o.latest);
    } catch (err) { failure(err); }
  };
  $('#pumpOnBtn').onclick = () => send('on');
  $('#pumpOffBtn').onclick = () => send('off');
}
function renderAck(s, dev, staleAfter, msg) {
  const offline = dev.age_seconds === null || dev.age_seconds > staleAfter;
  const el = $('#ack'); if (!el) return;
  el.innerHTML = (msg ? `<div class="note ok">${esc(msg)}</div>` : '') + (s.acknowledged
    ? `<p><span class="chip ok">Acknowledged</span></p><p class="small muted">The device confirmed settings version ${s.version}${s.acked_at ? ' at ' + fmtTimeS(s.acked_at) : ''}.</p>`
    : `<p><span class="chip warn">Waiting for device</span></p><p class="small muted">Version ${s.version} is saved. The device applies it the next time it reports in${offline ? '. <b>It looks offline right now</b>, so it will apply this when it reconnects.' : '.'}</p>`)
    + `<p class="small">Current values: fan ON ${s.temp_on} °C · fan OFF ${s.temp_off} °C · pump below ${s.soil_low} %</p>`;
}

// =====================================================================
//  ADMIN VIEWS
// =====================================================================
const A = { userId: '', deviceId: '' };

VIEWS['a-overview'] = async () => {
  const o = await api('/api/admin/overview');
  const tile = (k, v, sub) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="muted small">${sub || '&nbsp;'}</div></div>`;
  $('#view').innerHTML = `<div class="pagehead"><h2>System overview</h2></div>
    <div class="tiles">${tile('Registered users', o.users.total, `${o.users.active} active · ${o.users.admins} admin`)}${tile('Prototypes', o.devices.total, `${o.devices.online} online now`)}${tile('Assignments', o.assignments, 'user ↔ prototype')}${tile('Readings stored', o.readings.toLocaleString(), '')}${tile('Alerts, 24 h', o.alerts_24h, '')}</div>
    <div class="card"><h3>Recent system activity</h3>${activityTable(o.recent_activity)}</div>`;
};

function activityTable(rows) {
  if (!rows.length) return '<div class="empty small">No activity yet.</div>';
  const sev = (a) => (a === 'access_denied' || a === 'login_failed' || a === 'ai_failed' ? 'bad' : a.startsWith('settings') ? 'info' : 'plain');
  return `<div class="tablewrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtTimeS(r.created_at)}</td><td>${esc(r.email || '—')}</td><td><span class="chip ${sev(r.action)}">${esc(r.action)}</span></td><td>${esc(r.detail || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

VIEWS['a-activity'] = async () => {
  const [users, rows] = await Promise.all([api('/api/admin/users'), api('/api/admin/activity?limit=200' + (A.userId ? '&user_id=' + A.userId : ''))]);
  $('#view').innerHTML = `<div class="pagehead"><h2>Activity record</h2><div><label class="small muted" for="actUser">User</label> <select id="actUser" style="width:auto"><option value="">All users</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === String(A.userId) ? 'selected' : ''}>${esc(u.email)}</option>`).join('')}</select></div></div>
    <div class="card">${activityTable(rows)}</div>`;
  $('#actUser').onchange = (e) => { A.userId = e.target.value; go(); };
};

VIEWS['a-users'] = async () => {
  const users = await api('/api/admin/users');
  $('#view').innerHTML = `<div class="pagehead"><h2>Accounts</h2></div><div class="card tablewrap"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th class="num">Greenhouses</th><th>Registered</th><th></th></tr></thead><tbody>
    ${users.map((u) => { const me = u.id === S.user.id || u.email === S.user.email; return `<tr><td>${esc(u.email)}${me ? ' <span class="chip plain">you</span>' : ''}</td>
      <td><select data-role="${u.id}" ${me ? 'disabled' : ''} style="width:auto;min-height:36px"><option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select></td>
      <td><span class="chip ${u.active ? 'ok' : 'bad'}">${u.active ? 'Active' : 'Deactivated'}</span></td><td class="num">${u.device_count}</td><td>${fmtDT(u.created_at)}</td>
      <td>${me ? '' : `<button class="btn sm ${u.active ? 'ghost' : ''}" data-act="toggle-user" data-id="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'Deactivate' : 'Activate'}</button>`}</td></tr>`; }).join('')}</tbody></table></div>`;
  document.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => { try { await api('/api/admin/users/' + s.dataset.role, { method: 'PUT', body: { role: s.value } }); go(); } catch (e) { failure(e); go(); } }));
};
ACT['toggle-user'] = async (el) => { await api('/api/admin/users/' + el.dataset.id, { method: 'PUT', body: { active: el.dataset.active !== '1' } }); go(); };

VIEWS['a-monitor'] = async () => {
  $('#view').innerHTML = `<div class="pagehead"><h2>System monitoring</h2><span class="muted small">Refreshes every 5 s</span></div><div id="mon"></div><div class="card"><h3>Alerts across all prototypes (last 24 h)</h3><div id="monAlerts"></div></div>`;
  const load = async () => {
    const [mon, al] = await Promise.all([api('/api/admin/monitor'), api('/api/admin/alerts')]);
    if (S.view !== 'a-monitor') return;
    banner('');
    $('#mon').innerHTML = mon.length ? `<div class="grid g2">${mon.map((d) => { const l = d.latest, stale = !d.online;
      return `<div class="card"><div class="row between"><h3 style="margin:0">${esc(d.name)}</h3>${d.age_seconds === null ? '<span class="chip plain">No data yet</span>' : d.online ? `<span class="chip ok">Online · ${fmtAge(d.age_seconds)} ago</span>` : `<span class="chip warn">Stale · ${fmtAge(d.age_seconds)} ago</span>`}</div>
        ${l ? `<p style="margin:10px 0 4px;${stale ? 'opacity:.55' : ''}"><b>${fmt(l.temperature)} °C</b> · ${fmt(l.humidity, 0)} % humidity · ${fmt(l.soil_moisture, 0)} % soil · ${stateChip(l.state)}</p><p class="small muted">Fan ${onoff(l.fan_on)} · Pump ${onoff(l.pump_on)} · Light ${onoff(l.light_on)}</p>` : '<p class="muted">No readings yet.</p>'}
        <p class="small muted">Users: ${d.users.length ? esc(d.users.join(', ')) : 'none assigned'} · Alerts 24 h: <b>${d.alerts_24h}</b></p></div>`; }).join('')}</div>` : '<div class="card empty">No prototypes registered yet.</div>';
    $('#monAlerts').innerHTML = al.length ? `<div class="tablewrap"><table><thead><tr><th>Time</th><th>Prototype</th><th>Severity</th><th>Message</th></tr></thead><tbody>${al.map((a) => `<tr><td>${fmtTimeS(a.created_at)}</td><td>${esc(a.device_name)}</td><td class="sev-${esc(a.severity)}">${esc(a.severity)}</td><td>${esc(a.message)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No alerts in the last 24 hours.</div>';
  };
  await load(); every(5000, () => load().catch(failure));
};

VIEWS['a-devices'] = async () => {
  const [devs, users, asg, rules] = await Promise.all([api('/api/admin/devices'), api('/api/admin/users'), api('/api/admin/assignments'), api('/api/admin/rules')]);
  A.cache = { devs, users, asg, rules };
  $('#view').innerHTML = `<div class="pagehead"><h2>Devices, assignments &amp; alert rules</h2><button class="btn" data-act="dev-new">Add device</button></div>
    <div class="card tablewrap"><h3>Prototypes</h3><table><thead><tr><th>Name</th><th>Status</th><th>Settings</th><th>Users</th><th></th></tr></thead><tbody>
    ${devs.map((d) => `<tr><td><b>${esc(d.name)}</b><div class="small muted">id ${d.id}</div></td>
      <td>${d.age_seconds === null ? '<span class="chip plain">No data yet</span>' : d.online ? `<span class="chip ok">Online</span>` : `<span class="chip warn">Stale ${fmtAge(d.age_seconds)}</span>`}</td>
      <td class="small">fan ${d.settings.temp_on}/${d.settings.temp_off} °C · pump &lt; ${d.settings.soil_low} %<br><span class="chip ${d.settings.acknowledged ? 'ok' : 'warn'}">${d.settings.acknowledged ? 'acknowledged' : 'pending'}</span></td>
      <td class="small">${d.users.length ? d.users.map((u) => esc(u.email)).join('<br>') : '<span class="muted">none</span>'}</td>
      <td><div class="row"><button class="btn sm ghost" data-act="dev-pump-on" data-id="${d.id}" ${d.online ? '' : 'disabled title="Device is offline"'}>Pump ON</button><button class="btn sm ghost" data-act="dev-pump-off" data-id="${d.id}" ${d.online ? '' : 'disabled title="Device is offline"'}>Pump OFF</button><button class="btn sm ghost" data-act="dev-settings" data-id="${d.id}">Settings</button><button class="btn sm ghost" data-act="dev-rename" data-id="${d.id}">Rename</button><button class="btn sm ghost" data-act="dev-key" data-id="${d.id}">New key</button><button class="btn sm danger" data-act="dev-delete" data-id="${d.id}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No devices yet.</td></tr>'}</tbody></table></div>

    <div class="card"><div class="row between"><h3 style="margin:0">Assignments</h3><button class="btn" data-act="assign-new" ${devs.length && users.length ? '' : 'disabled'}>Assign user to prototype</button></div>
    <p class="small muted">A prototype can be shared by several users. Readings belong to the prototype, so shared data is never counted twice.</p>
    <div class="tablewrap"><table><thead><tr><th>User</th><th>Prototype</th><th></th></tr></thead><tbody>
    ${asg.map((a) => `<tr><td>${esc(a.email)}</td><td>${esc(a.device_name)}</td><td><div class="row"><button class="btn sm ghost" data-act="assign-move" data-u="${a.user_id}" data-d="${a.device_id}">Move</button><button class="btn sm danger" data-act="assign-del" data-u="${a.user_id}" data-d="${a.device_id}">Remove</button></div></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No assignments yet.</td></tr>'}</tbody></table></div></div>

    <div class="card"><div class="row between"><h3 style="margin:0">Alert rules</h3><button class="btn" data-act="rule-new" ${devs.length ? '' : 'disabled'}>Add rule</button></div>
    <div class="tablewrap"><table><thead><tr><th>Prototype</th><th>Condition</th><th>Message</th><th>Status</th><th></th></tr></thead><tbody>
    ${rules.map((r) => `<tr><td>${esc((devs.find((d) => d.id === r.device_id) || {}).name || r.device_id)}</td><td>${esc(r.metric.replace('_', ' '))} ${esc(r.operator)} ${esc(r.threshold)}</td><td>${esc(r.message)}</td><td><span class="chip ${r.enabled ? 'ok' : 'plain'}">${r.enabled ? 'enabled' : 'disabled'}</span></td>
      <td><div class="row"><button class="btn sm ghost" data-act="rule-edit" data-id="${r.id}">Edit</button><button class="btn sm danger" data-act="rule-del" data-id="${r.id}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No rules yet.</td></tr>'}</tbody></table></div></div>`;
};
const devOpts = () => A.cache.devs.map((d) => [d.id, d.name]);
const findDev = (id) => A.cache.devs.find((d) => d.id === Number(id));
ACT['dev-new'] = () => openForm({ title: 'Add device', fields: [{ name: 'name', label: 'Name', maxlength: 60 }], submit: 'Create', onSubmit: async (d) => { const r = await api('/api/admin/devices', { method: 'POST', body: { name: d.name } }); showKey('Device created', r.name, r.device_key); go(); } });
ACT['dev-rename'] = (el) => { const d = findDev(el.dataset.id); openForm({ title: 'Rename device', fields: [{ name: 'name', label: 'Name', value: d.name, maxlength: 60 }], onSubmit: async (x) => { await api('/api/admin/devices/' + d.id, { method: 'PUT', body: { name: x.name } }); go(); } }); };
ACT['dev-key'] = (el) => { const d = findDev(el.dataset.id); if (!confirm(`Create a new key for ${d.name}? The old key stops working immediately.`)) return; return api(`/api/admin/devices/${d.id}/rotate-key`, { method: 'POST' }).then((r) => showKey('New device key', d.name, r.device_key)); };
ACT['dev-delete'] = (el) => { const d = findDev(el.dataset.id); if (!confirm(`Delete ${d.name}? All its readings, alerts and rules are deleted too. This cannot be undone.`)) return; return api('/api/admin/devices/' + d.id, { method: 'DELETE' }).then(go); };
ACT['dev-pump-on'] = (el) => { const d = findDev(el.dataset.id); if (!confirm(`Switch the pump ON on ${d.name}? It stays on until you press Pump OFF (the device stops it after 60 seconds at most).`)) return; return api(`/api/admin/devices/${d.id}/pump`, { method: 'POST', body: { action: 'on' } }).then(() => alert('Pump ON queued. The device picks it up on its next report (about 10 seconds).')); };
ACT['dev-pump-off'] = (el) => { const d = findDev(el.dataset.id); return api(`/api/admin/devices/${d.id}/pump`, { method: 'POST', body: { action: 'off' } }).then(() => alert('Pump OFF queued. The device picks it up on its next report.')); };
ACT['dev-settings'] = (el) => {
  const d = findDev(el.dataset.id), s = d.settings;
  openForm({ title: 'Device settings: ' + d.name, intro: 'The device applies these the next time it reports in and then confirms them.', fields: [{ name: 'temp_on', label: 'Fan ON above (°C)', type: 'number', value: s.temp_on, min: 10, max: 50, step: 0.5 }, { name: 'temp_off', label: 'Fan OFF below (°C)', type: 'number', value: s.temp_off, min: 5, max: 49, step: 0.5 }, { name: 'soil_low', label: 'Pump ON below soil moisture (%)', type: 'number', value: s.soil_low, min: 5, max: 90, step: 0.5 }], onSubmit: async (x) => { await api(`/api/admin/devices/${d.id}/settings`, { method: 'PUT', body: x }); go(); } });
};
ACT['assign-new'] = () => openForm({ title: 'Assign user to prototype', fields: [{ name: 'user_id', type: 'select', label: 'User', options: A.cache.users.map((u) => [u.id, u.email]) }, { name: 'device_id', type: 'select', label: 'Prototype', options: devOpts() }], submit: 'Assign', onSubmit: async (x) => { await api('/api/admin/assign', { method: 'POST', body: { user_id: Number(x.user_id), device_id: Number(x.device_id) } }); go(); } });
ACT['assign-move'] = (el) => openForm({ title: 'Move user to another prototype', fields: [{ name: 'to', type: 'select', label: 'New prototype', options: devOpts().filter(([id]) => id !== Number(el.dataset.d)) }], submit: 'Move', onSubmit: async (x) => { await api('/api/admin/assign', { method: 'PUT', body: { user_id: Number(el.dataset.u), device_id: Number(el.dataset.d), new_device_id: Number(x.to) } }); go(); } });
ACT['assign-del'] = (el) => { if (!confirm('Remove this assignment? The user loses access to that prototype.')) return; return api('/api/admin/assign', { method: 'DELETE', body: { user_id: Number(el.dataset.u), device_id: Number(el.dataset.d) } }).then(go); };

const ruleFields = (r = {}) => [
  { name: 'device_id', type: 'select', label: 'Prototype', options: devOpts(), value: r.device_id },
  { name: 'metric', type: 'select', label: 'Measurement', options: [['temperature', 'Temperature (°C)'], ['humidity', 'Humidity (%)'], ['soil_moisture', 'Soil moisture (%)']], value: r.metric },
  { name: 'operator', type: 'select', label: 'Alert when value is', options: [['>', 'above (>)'], ['<', 'below (<)']], value: r.operator },
  { name: 'threshold', type: 'number', label: 'Threshold', value: r.threshold, step: 0.1 },
  { name: 'message', label: 'Message', value: r.message, maxlength: 120 },
  { name: 'enabled', type: 'checkbox', label: 'Enabled', value: r.enabled === undefined ? true : !!r.enabled }];
ACT['rule-new'] = () => openForm({ title: 'Add alert rule', fields: ruleFields(), submit: 'Create', onSubmit: async (x) => { await api('/api/admin/rules', { method: 'POST', body: { ...x, device_id: Number(x.device_id) } }); go(); } });
ACT['rule-edit'] = (el) => { const r = A.cache.rules.find((x) => x.id === Number(el.dataset.id)); openForm({ title: 'Edit alert rule', fields: ruleFields(r).filter((f) => f.name !== 'device_id'), onSubmit: async (x) => { await api('/api/admin/rules/' + r.id, { method: 'PUT', body: x }); go(); } }); };
ACT['rule-del'] = (el) => { if (!confirm('Delete this alert rule?')) return; return api('/api/admin/rules/' + el.dataset.id, { method: 'DELETE' }).then(go); };

// ----- system-wide analytics: filter, compare, AI -----
VIEWS['a-analytics'] = async () => {
  const [users, devs] = await Promise.all([api('/api/admin/users'), api('/api/admin/devices')]);
  const qs = `${rq()}${A.userId ? '&user_id=' + A.userId : ''}${A.deviceId ? '&device_id=' + A.deviceId : ''}`;
  const filters = `<div class="range"><div><label for="fUser">User</label><select id="fUser"><option value="">All users</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === String(A.userId) ? 'selected' : ''}>${esc(u.email)}</option>`).join('')}</select></div>
    <div><label for="fDev">Prototype</label><select id="fDev"><option value="">All prototypes</option>${devs.map((d) => `<option value="${d.id}" ${String(d.id) === String(A.deviceId) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div></div>`;
  $('#view').innerHTML = `<div class="pagehead"><h2>System analytics</h2></div>${filters}${rangeControls()}<div id="scope" class="note info"></div><div id="cmp"></div>`;
  const onF = () => { A.userId = $('#fUser').value; A.deviceId = $('#fDev').value; go(); };
  $('#fUser').onchange = onF; $('#fDev').onchange = onF;

  const [bundle, ser] = await Promise.all([api('/api/admin/analytics?' + qs), api('/api/admin/series?' + qs)]);
  const uName = A.userId ? (users.find((u) => String(u.id) === String(A.userId)) || {}).email : 'all users';
  $('#scope').innerHTML = scopeLine(bundle, uName);
  if (!bundle.devices.length) { $('#cmp').innerHTML = '<div class="card empty">No prototypes match these filters.</div>'; return; }

  const dev = (d) => d.stats;
  const cmpRows = bundle.devices.map((d) => { const s = dev(d), al = Object.values(d.measured.alerts_in_range).reduce((a, b) => a + b, 0);
    return `<tr><td><b>${esc(d.name)}</b></td><td class="num">${s.readings}</td><td class="num">${fmt(s.metrics.temperature.avg)}</td><td class="num">${fmt(s.metrics.temperature.max)}</td><td class="num">${fmt(s.metrics.humidity.avg, 0)}</td><td class="num">${fmt(s.metrics.soil_moisture.avg, 0)}</td><td class="num">${fmt(s.actuators.fan.on_percent)}</td><td class="num">${fmt(s.actuators.pump.on_percent)}</td><td class="num">${s.fault_readings}</td><td class="num">${al}</td><td class="num">${s.sampling.max_gap_s ?? '--'}</td></tr>`; }).join('');
  const acts = bundle.recorded_user_actions && Object.keys(bundle.recorded_user_actions).length ? Object.entries(bundle.recorded_user_actions).map(([k, v]) => `<span class="chip plain">${esc(k)} · ${v}</span>`).join(' ') : '<span class="muted small">none in range</span>';
  const fl = bundle.fleet_metrics_all_readings_counted_once;
  $('#cmp').innerHTML = `${metricChartsHtml()}
    <div class="card"><h3>Comparison across prototypes</h3><div class="tablewrap"><table><thead><tr><th>Prototype</th><th class="num">Readings</th><th class="num">Temp avg °C</th><th class="num">Temp max °C</th><th class="num">Humidity avg %</th><th class="num">Soil avg %</th><th class="num">Fan ON %</th><th class="num">Pump ON %</th><th class="num">FAULT readings</th><th class="num">Alerts</th><th class="num">Longest gap s</th></tr></thead><tbody>${cmpRows}</tbody></table></div>
      ${fl ? `<p class="small muted" style="margin-top:10px"><b>All prototypes together:</b> ${fl.readings} readings, each counted once even when a prototype has several users. Measurements stay separate: temperature avg ${fmt(fl.metrics.temperature.avg)} °C, humidity avg ${fmt(fl.metrics.humidity.avg, 0)} %, soil moisture avg ${fmt(fl.metrics.soil_moisture.avg, 0)} %.</p>` : ''}</div>
    <div class="card"><h3>Recorded user actions in range</h3><div class="row">${acts}</div></div>
    ${bundle.devices.map((d) => deviceStatsCard(d)).join('')}
    ${aiPanel('Based on the filters and time range selected above, across all matching prototypes.')}`;
  drawMetricCharts(ser.devices.map((d) => ({ name: d.name, points: d.points })), ser.bucket_seconds);
};

// ---------- Start ----------
if (S.token) startApp(); else $('#landing').classList.remove('hidden');
})();
