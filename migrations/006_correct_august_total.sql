-- ══════════════════════════════════════════════════════════════════════════
-- BizTrace — migration 006: correct companies_total for the 2026-08 release
--
-- ── What is wrong ────────────────────────────────────────────────────────
-- apply-diff.js stamped data_versions.companies_total with the size of the
-- ACRA RELEASE (2,110,094) rather than the size of the companies TABLE after
-- the load (2,110,096).
--
-- The two differ because the loader never deletes. Two UENs present in the
-- April release — 202452170K and 202452372C — are absent from August, and
-- they stay in the table. A company vanishing from an ACRA file is not
-- evidence it ceased to exist, and silently dropping rows the sales team may
-- already have enriched would be the worse failure.
--
-- ── Why it matters ───────────────────────────────────────────────────────
-- The frontend now reads this value for two things: the "DB: N companies"
-- header, and the result count it displays for an UNFILTERED query. That
-- second use is the reason it needs to describe the table rather than the
-- release — the proxy deliberately answers unfiltered queries with
-- total:null (rather than paying for a COUNT(*) over 2M rows) and the
-- frontend substitutes this number. If it is wrong, every unfiltered search
-- reports a wrong total.
--
-- Two rows out of 2.1 million is not going to mislead anyone. Fixing it
-- anyway because a number that means "the table" should count the table, and
-- the discrepancy is otherwise invisible and would quietly compound each
-- month as more UENs drop out of releases.
--
-- ── Going forward ────────────────────────────────────────────────────────
-- apply-diff.js now derives this itself as (previous total + rows inserted),
-- which is exact — inserts are the only thing that changes the row count —
-- and costs nothing, unlike a COUNT(*) across the table. This migration only
-- corrects the row that was written before that fix.
--
-- Idempotent: it sets an absolute value, so running it twice is harmless.
-- ══════════════════════════════════════════════════════════════════════════

UPDATE data_versions
   SET companies_total = 2110096
 WHERE month = '2026-08';
