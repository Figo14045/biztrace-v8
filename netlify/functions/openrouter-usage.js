// BizTrace — what OpenRouter says it has billed.
//
// WHY THIS EXISTS
// usage_log records every call that came BACK to us, with the charge OpenRouter
// reported for it. That answers "where did the money go" — per company, per
// day, per engine. What it cannot answer is "what were we actually billed",
// because a call killed by the Netlify function timeout is charged by
// OpenRouter and never returns to be logged.
//
// This endpoint asks OpenRouter directly. The two numbers have different jobs
// and are shown side by side rather than one replacing the other: ours is
// attributable, theirs is authoritative.
//
// It also surfaces the remaining balance, which is the early warning for the
// failure that produced a hundred rows reading "error": an exhausted account
// fails every call identically, and nothing in the app could see it coming.
//
//   GET /.netlify/functions/openrouter-usage  → { ok, usage, daily, weekly,
//                                                 monthly, limit, remaining }
//
// The API key never leaves the server; the browser only ever sees the totals.

const auth = require('./lib/auth.js');

const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// OpenRouter is a third party and this is a nice-to-have panel, not the app.
// A slow response must not hold a Netlify function open near its ~10s ceiling.
const TIMEOUT_MS = 6000;

exports.handler = async function (event) {
  const headers = auth.corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const gate = auth.requireAuth(event, headers);
  if (gate.response) return gate.response;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  if (!OPENROUTER_API_KEY) {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false, error: 'No OpenRouter key configured on the server', code: 'no_key' }) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(OPENROUTER_KEY_ENDPOINT, {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
      signal: controller.signal,
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: false,
        error: `OpenRouter returned ${r.status}`,
        detail: text.slice(0, 300),
      }) };
    }

    const json = await r.json();
    const d = json && json.data ? json.data : json;
    const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true,
      usage:     num(d.usage),            // all time, this key
      daily:     num(d.usage_daily),      // current UTC day
      weekly:    num(d.usage_weekly),     // current UTC week
      monthly:   num(d.usage_monthly),    // current UTC month
      limit:     num(d.limit),            // null when the key is uncapped
      remaining: num(d.limit_remaining),  // null when the key is uncapped
    }) };
  } catch (e) {
    // Aborts land here too. Either way the panel simply does not show a billed
    // figure — it must never take the Spend view down with it.
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false,
      error: e.name === 'AbortError' ? 'OpenRouter did not respond in time' : e.message,
    }) };
  } finally {
    clearTimeout(timer);
  }
};
