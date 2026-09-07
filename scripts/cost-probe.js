#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════
// Measure what one enrichment actually costs on OpenRouter.
//
//   node scripts/cost-probe.js
//   node scripts/cost-probe.js --company "SHOPEE SINGAPORE PRIVATE LIMITED"
//   node scripts/cost-probe.js --repeat 5
//   node scripts/cost-probe.js --no-search        # isolate the search cost
//
// Needs OPENROUTER_API_KEY in your .env (it currently only lives in Netlify).
//
// ── Why this exists ──────────────────────────────────────────────────────
// The cost of an enrichment was estimated at roughly $0.03, built from
// published rates: $1/M input, $5/M output, and $4 per 1,000 search results
// at the 5 results openrouter-enrich.js requests. The token half of that is
// arithmetic and trustworthy. The search half assumes how OpenRouter bills
// its web plugin, and that is a guess.
//
// This does not estimate. It sends one real request with the same model,
// the same plugin config and the same max_tokens as production, then asks
// OpenRouter's generation endpoint what it actually charged. That figure
// includes the web plugin, so it settles the part the estimate could not.
//
// Run it with --no-search as well and the difference between the two IS the
// search cost, measured rather than assumed.
//
// Writes nothing to the database and does not touch the deployed site.
// ══════════════════════════════════════════════════════════════════════════

require('./lib/turso');   // loads .env into process.env

const ENDPOINT   = 'https://openrouter.ai/api/v1/chat/completions';
const GENERATION = 'https://openrouter.ai/api/v1/generation';

// Kept deliberately identical to netlify/functions/openrouter-enrich.js.
// If you change the model or the cap there, change it here or the numbers
// stop describing production.
const MODEL      = 'anthropic/claude-haiku-4.5';
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.2;
const MAX_RESULTS = 5;

// Published rates, used only for the SANITY-CHECK column. The authoritative
// number is what OpenRouter reports it charged; if these two disagree, trust
// OpenRouter and treat the difference as something the estimate was missing.
const USD_PER_M_INPUT  = 1.00;
const USD_PER_M_OUTPUT = 5.00;

function parseArgs(argv) {
  const a = { repeat: 1, search: true, company: 'DBS BANK LTD' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--company')       a.company = argv[++i];
    else if (argv[i] === '--repeat')   a.repeat = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (argv[i] === '--no-search') a.search = false;
    else { console.error(`Unknown argument: ${argv[i]}`); process.exitCode = 1; a.bad = true; }
  }
  return a;
}

// Same shape and roughly the same size as buildPrompt() in the production
// function (measured at ~2,650 tokens). Not byte-identical — it is here to
// make the request representative, not to duplicate that file.
function buildPrompt(company) {
  return `You are a research assistant helping a Singapore B2B sales team qualify leads.

Company: ${company}
Registered in Singapore with ACRA.

Find the company's official website, a contact email address and a contact
phone number. Only report details you can attribute to a specific page you
have actually read.

Return JSON with exactly these keys:
  website, email, phone, identity_confidence, contact_confidence,
  identity_reason, contact_reason, email_source_url, phone_source_url

identity_confidence and contact_confidence must each be one of
HIGH, MEDIUM, LOW or NONE.

Rules:
- A generic directory listing is not the company's own website.
- Do not guess an email from a pattern; report only addresses you have seen.
- If you cannot verify the company at all, return NONE and say why.
- Prefer the company's own domain over aggregators.`;
}

async function oneCall(apiKey, company, useSearch) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: buildPrompt(company) }],
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
  };
  if (useSearch) body.plugins = [{ id: 'web', max_results: MAX_RESULTS }];

  const started = Date.now();
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://biztracev8.netlify.app',
      'X-Title': 'BizTrace cost probe',
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - started;

  const text = await r.text();
  if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}: ${text.slice(0, 300)}`);

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Unparseable response: ${text.slice(0, 200)}`); }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

  const content = json.choices?.[0]?.message?.content || '';
  return { id: json.id, usage: json.usage || {}, content, elapsed, model: json.model };
}

// OpenRouter settles the ledger asynchronously, so the generation record can
// lag the response by a second or two. Retry briefly rather than reporting a
// missing cost as zero.
async function fetchCost(apiKey, id, attempt = 0) {
  const r = await fetch(`${GENERATION}?id=${encodeURIComponent(id)}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (r.status === 404 && attempt < 5) {
    await new Promise(res => setTimeout(res, 1500));
    return fetchCost(apiKey, id, attempt + 1);
  }
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.data || null;
}

function usd(n) {
  if (n == null || Number.isNaN(n)) return '     —    ';
  return '$' + Number(n).toFixed(5);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad) return;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('\nOPENROUTER_API_KEY is not set.\n');
    console.error('It lives in Netlify, not in your local .env. Copy it from');
    console.error('Netlify -> Site configuration -> Environment variables and add:');
    console.error('\n  OPENROUTER_API_KEY=sk-or-...\n');
    console.error('to the .env at the repo root. .env is gitignored.');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('OpenRouter cost probe');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Model      : ${MODEL}`);
  console.log(`Web search : ${args.search ? `on (plugin "web", max_results ${MAX_RESULTS})` : 'OFF'}`);
  console.log(`Company    : ${args.company}`);
  console.log(`Calls      : ${args.repeat}`);
  console.log('');
  console.log('  #   in     out    latency   est. tokens   OPENROUTER CHARGED  confidence');
  console.log('  ───────────────────────────────────────────────────────────────────────');

  const charged = [];
  const estimated = [];

  for (let i = 1; i <= args.repeat; i++) {
    let call;
    try {
      call = await oneCall(apiKey, args.company, args.search);
    } catch (e) {
      console.log(`  ${String(i).padStart(2)}  FAILED — ${e.message}`);
      continue;
    }

    const inTok  = call.usage.prompt_tokens ?? 0;
    const outTok = call.usage.completion_tokens ?? 0;
    const est = (inTok / 1e6) * USD_PER_M_INPUT + (outTok / 1e6) * USD_PER_M_OUTPUT;

    const gen = await fetchCost(apiKey, call.id);
    const real = gen?.total_cost != null ? Number(gen.total_cost) : null;

    // If grounding has silently stopped working, every answer comes back with
    // no confidence — the symptom the production file warns about.
    const conf = (call.content.match(/"identity_confidence"\s*:\s*"([A-Z]+)"/) || [])[1] || '?';

    estimated.push(est);
    if (real != null) charged.push(real);

    console.log(
      `  ${String(i).padStart(2)}  ${String(inTok).padStart(6)} ${String(outTok).padStart(6)}` +
      `  ${String(call.elapsed + 'ms').padStart(7)}   ${usd(est)}      ${usd(real)}        ${conf}`
    );
  }

  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const avgCharged = avg(charged);
  const avgEst = avg(estimated);

  console.log('');
  if (avgCharged != null) {
    console.log(`  Average charged per enrichment : ${usd(avgCharged)}`);
    console.log(`  Tokens alone would be          : ${usd(avgEst)}`);
    const gap = avgCharged - avgEst;
    if (args.search && gap > 0) {
      console.log(`  Difference (search + overhead) : ${usd(gap)}  ← the part that was guessed`);
    }
    console.log('');
    // Five decimal places make sense for one call and look absurd for a
    // thousand, so scale the precision with the magnitude.
    console.log(`  1,000 enrichments ≈ $${(avgCharged * 1000).toFixed(2)}`);
    console.log(`  10,000 enrichments ≈ $${(avgCharged * 10000).toFixed(2)}`);
  } else {
    console.log('  OpenRouter did not return a cost for these generations.');
    console.log(`  Falling back to the token estimate: ${usd(avgEst)} per enrichment.`);
  }

  if (args.search) {
    console.log('');
    console.log('  Run again with --no-search and subtract: that difference is the');
    console.log('  measured cost of the web plugin, rather than an assumed one.');
  }
  console.log('');
}

// Set exitCode rather than calling process.exit(). On Windows, exiting while
// the HTTP client still has sockets closing trips an assertion inside libuv.
main().catch(err => {
  console.error('');
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
