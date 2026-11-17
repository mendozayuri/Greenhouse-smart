// AI analytics (Gemini). Runs ONLY on the server so the API key is never sent to the browser.
// The AI receives numbers that stats.js already calculated. It interprets; it does not calculate.

const ALLOWED_SETTINGS = {
  temp_on:  { min: 10, max: 50, label: 'fan ON temperature (°C)' },
  temp_off: { min: 5,  max: 49, label: 'fan OFF temperature (°C)' },
  soil_low: { min: 5,  max: 90, label: 'pump ON soil moisture (%)' }
};

const KINDS = {
  summary: 'Summarize the main trends over the selected period for each measurement separately (temperature, humidity, soil moisture) and how the fan, pump and light behaved.',
  anomalies: 'Explain the candidate anomalies listed in "anomalies_detected_by_code". For each, give the most plausible explanation that the supplied data supports (for example a heat spike followed by fan activity, or a sensor dropout), and say clearly when the cause cannot be known from this data.',
  compare: 'Compare the current period with the previous period using "comparison_calculated_by_code". Describe what changed in operating conditions and whether the change looks meaningful.',
  recommend: 'Recommend operational adjustments that the recorded data supports. When a recommendation maps to a device setting, set "setting" to one of temp_on, temp_off, soil_low and give "suggested_value" within the allowed range; otherwise use null. These are suggestions that a human will review; nothing is applied automatically.'
};

const SYSTEM = `You are the analytics assistant of a smart greenhouse monitoring system.
Rules you must follow:
1. Use ONLY the JSON data supplied by the user message. Never invent readings, dates, devices or causes.
2. Do NOT calculate new numbers (no averages, differences or percentages of your own). Quote numbers exactly as supplied.
3. Keep temperature (°C), humidity (%) and soil moisture (%) separate; never combine them into one score.
4. If the data is too small or inconclusive, say so in "limitations" and lower "confidence".
5. Separate what the data shows (findings) from what you think it means (recommendations).
6. Reply with a single JSON object only, matching this shape:
{"summary": string, "findings": [{"text": string, "evidence": string}], "recommendations": [{"text": string, "setting": "temp_on"|"temp_off"|"soil_low"|null, "suggested_value": number|null, "evidence": string}], "confidence": "low"|"medium"|"high", "limitations": string}
"evidence" names the supplied field(s) you relied on, for example "metrics.temperature.max".`;

class AiError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

function buildPrompt(kind, payload) {
  if (!KINDS[kind]) throw new AiError('BAD_KIND', 'Unknown analysis type', 400);
  return `TASK: ${KINDS[kind]}\n\nALLOWED SETTING RANGES: ${JSON.stringify(ALLOWED_SETTINGS)}\n\nDATA (all numbers calculated by the application):\n${JSON.stringify(payload)}`;
}

// Model names change often and models are sometimes overloaded. If the configured model is not
// available for this key (HTTP 404) or the service is busy (HTTP 500/502/503/504), the next model in
// the list is tried, so one retired or overloaded model does not break the analytics.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest'];

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AiError('NOT_CONFIGURED', 'AI analysis is not configured on the server (missing GEMINI_API_KEY).', 503);
  const first = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const models = [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

  let lastStatus = 0;
  for (const model of models) {
    let res;
    try {
      res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
        }),
        signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 60000)
      });
    } catch (e) {
      const why = (e && e.name === 'TimeoutError') ? 'timed out' : ((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'unknown error');
      console.warn(`AI request to Google failed (${why})`);
      throw new AiError('UNAVAILABLE', `The AI service could not be reached or took too long (${why}). Check the internet connection of the computer running the website. Statistics are still shown below.`);
    }
    if (res.status === 404 || [500, 502, 503, 504].includes(res.status)) {
      lastStatus = res.status;
      console.warn(`AI model "${model}" answered ${res.status}, trying the next one`);
      continue;
    }
    if (res.status === 429) throw new AiError('RATE_LIMITED', 'The AI service usage limit was reached. Try again later.', 429);
    if (!res.ok) throw new AiError('UNAVAILABLE', `The AI service returned an error (${res.status}) for model ${model}. Statistics are still shown below.`);
    const data = await res.json().catch(() => null);
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
      ? data.candidates[0].content.parts.map((p) => p.text || '').join('') : '';
    if (!text) throw new AiError('EMPTY', 'The AI service returned an empty answer.');
    return { text, model };
  }
  if (lastStatus === 404)
    throw new AiError('UNAVAILABLE', `None of these AI models is available for this API key: ${models.join(', ')}. Set GEMINI_MODEL in .env to a model listed in Google AI Studio. Statistics are still shown below.`);
  throw new AiError('UNAVAILABLE', `The AI service is busy right now (error ${lastStatus}) for every model tried: ${models.join(', ')}. Wait a minute and press the button again. Statistics are still shown below.`);
}

// Collect every number that appears in the supplied data, so we can detect numbers the AI made up.
function numbersIn(obj, set = new Set()) {
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    for (const d of [0, 1, 2]) set.add(Number(obj.toFixed(d)));
    set.add(Math.abs(Number(obj.toFixed(1))));
  } else if (typeof obj === 'string') {
    for (const m of obj.match(/\d+(?:\.\d+)?/g) || []) set.add(Number(m));
  } else if (Array.isArray(obj)) obj.forEach((x) => numbersIn(x, set));
  else if (obj && typeof obj === 'object') Object.values(obj).forEach((x) => numbersIn(x, set));
  return set;
}

// Returns numbers mentioned in the AI text that do not exist in the supplied data.
function unsupportedNumbers(aiTexts, payload) {
  const known = numbersIn(payload);
  const bad = new Set();
  for (let t of aiTexts) {
    t = String(t || '')
      .replace(/\d{4}-\d{2}-\d{2}[T ]?(\d{2}:\d{2}(:\d{2})?)?(\.\d+)?Z?/g, ' ')   // dates and times
      .replace(/\d{1,2}:\d{2}/g, ' ')
      .replace(/\b(?:temp_on|temp_off|soil_low)\b/g, ' ');
    for (const m of t.match(/-?\d+(?:\.\d+)?/g) || []) {
      const n = Math.abs(Number(m));
      if (n <= 3 && Number.isInteger(n)) continue;          // "2 sensors", "3 periods" style words
      if (!known.has(n) && !known.has(Number(n.toFixed(1))) && !known.has(Math.round(n))) bad.add(m);
    }
  }
  return [...bad];
}

function cleanSetting(rec) {
  if (!rec || !rec.setting) return { setting: null, suggested_value: null };
  const rule = ALLOWED_SETTINGS[rec.setting];
  const v = Number(rec.suggested_value);
  if (!rule || !Number.isFinite(v) || v < rule.min || v > rule.max) return { setting: null, suggested_value: null, rejected: true };
  return { setting: rec.setting, suggested_value: v };
}

function parseAndValidate(text, payload) {
  let obj;
  try { obj = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw new AiError('BAD_FORMAT', 'The AI answer was not in the expected format. Please try again.'); }
  if (!obj || typeof obj.summary !== 'string') throw new AiError('BAD_FORMAT', 'The AI answer was not in the expected format. Please try again.');

  const findings = (Array.isArray(obj.findings) ? obj.findings : []).slice(0, 8)
    .map((f) => ({ text: String(f.text || '').slice(0, 600), evidence: String(f.evidence || '').slice(0, 200) })).filter((f) => f.text);
  const recommendations = (Array.isArray(obj.recommendations) ? obj.recommendations : []).slice(0, 6).map((r) => {
    const c = cleanSetting(r);
    return { text: String(r.text || '').slice(0, 600), evidence: String(r.evidence || '').slice(0, 200), setting: c.setting, suggested_value: c.suggested_value, setting_rejected: !!c.rejected };
  }).filter((r) => r.text);
  const confidence = ['low', 'medium', 'high'].includes(obj.confidence) ? obj.confidence : 'low';
  const result = { summary: obj.summary.slice(0, 1200), findings, recommendations, confidence, limitations: String(obj.limitations || '').slice(0, 600) };

  const texts = [result.summary, result.limitations, ...findings.map((f) => f.text), ...recommendations.map((r) => r.text)];
  const bad = unsupportedNumbers(texts, payload);
  result.warnings = [];
  if (bad.length) result.warnings.push(`Figures not found in the calculated statistics (verify before relying on them): ${bad.join(', ')}`);
  if (recommendations.some((r) => r.setting_rejected)) result.warnings.push('A suggested setting value was outside the allowed range and was removed.');
  return result;
}

async function analyze(kind, payload) {
  const prompt = buildPrompt(kind, payload);
  const { text, model } = await callGemini(prompt);
  return { model, result: parseAndValidate(text, payload) };
}

module.exports = { analyze, AiError, buildPrompt, parseAndValidate, unsupportedNumbers, ALLOWED_SETTINGS, KINDS };
