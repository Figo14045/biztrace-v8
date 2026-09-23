-- ══════════════════════════════════════════════════════════════════════════
-- BizTrace — migration 008: record what each paid lookup actually cost
--
-- ── The problem ──────────────────────────────────────────────────────────
-- Enrichment spends real money, roughly US$0.011 a company on OpenRouter, and
-- the only place that spend is visible is the OpenRouter dashboard. Nobody
-- can answer "what did this month's prospecting cost" from inside BizTrace,
-- and nobody can attribute spend to a search, a day, or a person.
--
-- ── Why its own table, not columns on enrichments ────────────────────────
-- The obvious move is three columns on `enrichments`. It is wrong, and in a
-- way that would quietly understate the bill.
--
-- `enrichments` holds one row per company we have a RESULT for. But OpenRouter
-- charges for the call, not the result. A call that returns text we cannot
-- parse is billed and saves no row. A call whose save later fails is billed
-- and saves no row. A retry is billed twice and saves once. Cost stored on the
-- result can only ever describe the subset that worked, so a total built from
-- it would read lower than the real bill — and the gap would grow exactly when
-- something is going wrong, which is when the number matters most.
--
-- One row per CALL fixes that. It also gives us per-model and per-day totals
-- for free, and a place to record failures, which `enrichments` has no room
-- for.
--
-- ── Where the numbers come from ──────────────────────────────────────────
-- `usage: { include: true }` on the request makes OpenRouter return the real
-- charge in the completion response (usage.cost), so this needs no second API
-- call — which matters, because the Netlify function budget is ~10s and a
-- lookup with web search already uses 5-15s of it.
--
-- cost_usd is what OpenRouter says it charged for that generation. It is not
-- an estimate derived from token counts and a price list, which would drift
-- every time OpenRouter changed pricing or routed us to a different model.
--
-- ── The one gap, stated honestly ─────────────────────────────────────────
-- A call killed by the Netlify timeout never returns to us, so it is billed
-- and not logged. Nothing here can close that; only reconciling against the
-- OpenRouter account can reveal it. scripts/reconcile-spend.js exists for
-- that, and the UI says "recorded here" rather than "spent", because those
-- are different claims.
--
-- ── Engines other than OpenRouter ────────────────────────────────────────
-- Gemini's free tier costs nothing but consumes a daily quota; SerpAPI spends
-- a monthly allowance. Neither bills in dollars, so cost_usd stays NULL for
-- them. NULL means "not known in dollars", which is not the same as 0.00, and
-- the UI must not render it as such.
--
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- When the call was made, UTC ISO-8601, generated server-side.
  called_at         TEXT NOT NULL,

  -- Which company the call was about. Not a foreign key: we log calls that
  -- never produced an enrichments row, which is the entire point.
  uen               TEXT,

  -- 'openrouter' | 'ai' (Gemini) | 'claude' | 'serp'
  engine            TEXT NOT NULL,

  -- The model that actually served the request. With OpenRouter this can
  -- differ from what we asked for, because of fallback routing.
  model_used        TEXT,

  -- What the provider says it charged, in USD. NULL when the engine does not
  -- bill in dollars, or when the provider returned no usage block.
  cost_usd          REAL,

  prompt_tokens     INTEGER,
  completion_tokens INTEGER,

  -- 'ok'     — the call returned a usable result
  -- 'failed' — the call returned, but we could not use it (unparseable
  --            response, unexpected shape, provider error). Still billed.
  outcome           TEXT NOT NULL DEFAULT 'ok'
);

-- Totals are always asked for over a date range ("this month", "today"), so
-- the range scan is the query to serve. usage_log grows by one row per
-- lookup — a few thousand a month at current volumes.
CREATE INDEX IF NOT EXISTS idx_usage_log_called_at ON usage_log(called_at);

-- Attribution by company, for "why did we pay for this one twice".
CREATE INDEX IF NOT EXISTS idx_usage_log_uen ON usage_log(uen);
