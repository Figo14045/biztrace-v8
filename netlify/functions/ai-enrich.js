// BizTrace V8 — AI Enrichment Proxy (Gemini)
//
// Receives a single company's ACRA details + the user's Gemini API key,
// calls Gemini 2.5 Flash with Google Search grounding, and returns
// structured contact information back to the frontend.
//
// Request body:
//   {
//     api_key: "AIza...",           // user's Gemini key
//     company: {
//       entity_name: "DUPONT SPECIALTY MATERIALS SINGAPORE PTE. LTD.",
//       uen: "201234567A",
//       entity_type_description: "Local Co.",
//       entity_status_description: "Live Company",
//       full_address: "10 MARINA BOULEVARD #07-01 MARINA BAY FINANCIAL CENTRE SINGAPORE 018983",
//       primary_ssic_code: "20119",
//       primary_ssic_description: "MANUFACTURE OF OTHER CHEMICAL PRODUCTS"
//     }
//   }
//
// Response:
//   {
//     ok: true,
//     result: {
//       website: "https://..." | null,
//       email: "..." | null,
//       phone: "..." | null,
//       linkedin: "..." | null,
//       description: "...",
//       confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE",
//       verification_method: "uen_match" | "address_match" | "name_only" | "unverified",
//       reasoning: "..."
//     },
//     raw_text: "..."  // included on parse failure for debugging
//   }

// Gemini 2.5 Flash-Lite. This is the only model verified to work on this
// account WITH Google Search grounding.
//
// Observed free-tier limits on this account (NOT the published figures):
//   - 20 requests per DAY (RPD). This is the binding constraint: one company
//     enriched = one request, so ~20 companies/day per API key.
//   - ~5-10 requests per minute (RPM), handled by the frontend throttle.
//   - Search grounding has a separate, much larger budget (~1.5K/day) but it
//     cannot be used once the 20 model requests are spent.
//
// Tried and rejected:
//   - 'gemini-2.5-flash'      → same 20 RPD cap, no benefit.
//   - 'gemini-3.1-flash-lite' → console shows 500 RPD, but this key gets a
//     generic RESOURCE_EXHAUSTED with no limit/model named, i.e. no access.
//
// The 20/day ceiling is a billing limit, not a code problem. To lift it,
// enable billing on the Google Cloud project, or use the Claude engine
// (see claude-enrich.js), which has no daily cap.
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function buildPrompt(company) {
  // Defensive: replace 'na' or empty strings with explicit "not provided"
  // so the model knows what's unknown vs literally the string "na".
  const clean = (v) => (v && v !== 'na' && v !== '') ? v : '(not provided)';

  return `You are helping a Singapore B2B sales team work out which website, if any, belongs to a company registered with ACRA.

ACRA REGISTRY RECORD (this is ground truth — it came from the official registry):
- Registered name: ${clean(company.entity_name)}
- UEN: ${clean(company.uen)}
- Entity type: ${clean(company.entity_type_description)}
- Status: ${clean(company.entity_status_description)}
- Registered address: ${clean(company.full_address)}
- Postal code: ${clean(company.postal_code)}  <-- a Singapore postal code identifies ONE building
- Building: ${clean(company.building_name)}
- Street: ${clean(company.street_name)}
- Primary SSIC (industry code): ${clean(company.primary_ssic_code)}

YOUR TASK:
Search the web and return UP TO THREE candidate official websites that might belong to this registered entity. Then respond with ONLY a JSON object — no prose, no markdown fences.

You are NOT being asked for an email address or a phone number. Do not supply them. Another system retrieves those directly from the page. Your only job is to work out WHICH SITE IS THEM, and to say honestly how sure you are.

CRITICAL — THE CIRCULAR EVIDENCE TRAP:
Sites such as sgpbusiness.com, companies.sg, opencorporates.com, sgcompanyinfo, bizfile listings and similar business directories are COPIES OF THE ACRA REGISTRY. They contain the same UEN, name and registered address that is printed above.

Finding the UEN on one of those sites proves NOTHING. It tells you the registry says what the registry says. It is circular. It must NEVER produce HIGH confidence.
A UEN is strong evidence ONLY when it appears on a site that is NOT a registry copy — typically the company's own website (often in a footer, on an About page, or on an invoice/terms page).

Directories are still useful for one thing: they sometimes name a website or a trading name. Treat that as a LEAD to investigate, never as proof.

CRITICAL — DO NOT REJECT ON NAME ALONE:
The registered ACRA name and the public trading brand are frequently different. "AXIOM STRATIX PTE LTD" could genuinely trade as "Axiom Tech". Do NOT discard a candidate merely because the brand differs from the registered name. Weigh the other evidence.

USE THE ADDRESS. It is the strongest evidence you have when the names differ.
- The postal code above identifies exactly ONE building in Singapore. If a candidate site publishes that postal code, or that building name, or that street, on its contact/about page, that is a REAL link to this entity — regardless of what the brand is called.
- Search for the address, not only the name. A brand you have never heard of, sitting at this exact address, is far more likely to be them than a famous company with a similar name in another country.
- Conversely: a candidate in a DIFFERENT COUNTRY cannot be this entity. This is a SINGAPORE registered entity at the Singapore address above. If the candidate is Australian, Indian, British — say so and mark LOW, no matter how similar the name is.

But the reverse trap is worse: DO NOT claim two companies are the same just because they share a word. A shared word plus a DIFFERENT INDUSTRY or a DIFFERENT COUNTRY means they are almost certainly unrelated — say so, and mark it LOW.

EVIDENCE TO WEIGH (in rough order of strength):
1. Exact UEN shown on the candidate's own (non-directory) site
2. Registered address or postal code shown on the candidate's site
3. Former/previous company name matching the candidate's brand
4. Business activity consistent with the SSIC code, AND a genuine Singapore presence
5. Name similarity only — weakest

CONFIDENCE — be honest, an unhelpful truth beats a helpful lie:
- "HIGH"   — UEN or registered address confirmed on the candidate's OWN site. A real link exists between the registry entity and this web presence.
- "MEDIUM" — strong brand, former-name or business-activity evidence, plus a Singapore presence. Plausible, not proven.
- "LOW"    — name similarity only, OR the UEN was found only in registry-copy directories, OR the activity/country does not line up.

verification_method must be one of:
  uen_on_own_site, address_match, former_name_match, brand_and_activity_match, name_only, directory_only, unverified

OUTPUT FORMAT (exact JSON, no other text):
{
  "candidates": [
    {
      "company_name": "Public/trading name of this candidate",
      "website": "https://example.com",
      "confidence": "MEDIUM",
      "verification_method": "brand_and_activity_match",
      "reasoning": "MAXIMUM 2 sentences. Name the evidence and the source domain. If you are unsure, say what does not line up."
    }
  ],
  "description": "1-2 sentence summary of what the ACRA entity does, based on the registry record and anything credible you found."
}

RULES:
- Up to THREE candidates. Best first.
- If you find NO plausible website at all, return "candidates": [] and still give a description. That is a useful, honest answer — do not invent a candidate to fill the space.
- If a company appears to have no web presence (small firm, residential registered address), say exactly that in the description.
- Never invent a URL. Only list a site you actually saw in search results.
- Do NOT return email or phone fields.
- Keep reasoning SHORT and factual. Cite domains, not full URLs.
- Output ONLY the JSON object.`;
}

// Attempt to extract a JSON object from arbitrary text output.
// Gemini sometimes wraps JSON in ```json ... ``` fences despite instructions,
// or prepends a "Here's the result:" line. It also sometimes gets truncated
// when it hits the maxOutputTokens limit — we attempt simple repair in
// that case.
function extractJson(text) {
  if (!text) return null;

  // Strategy 1: try parsing directly first
  try { return JSON.parse(text); } catch (e) {}

  // Strategy 2: strip markdown fences
  let cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch (e) {}

  // Strategy 3: find the first { and matching final }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch (e) {}
  }

  // Strategy 4: response was truncated mid-string (no closing } at all).
  // Attempt naive repair: trim back to the last complete "key": value pair
  // and append closing brace.
  if (start !== -1) {
    let body = text.slice(start);
    // Walk back from end until we find a comma or closing brace at top level
    // We try several repair points to find one that parses.
    for (let cut = body.length; cut > 0; cut--) {
      let snippet = body.slice(0, cut);
      // Trim trailing whitespace/garbage
      snippet = snippet.replace(/[\s,]+$/, '');
      // Try closing any open quote, then close the object
      // Count unescaped quotes — if odd, we're mid-string, close it.
      const quoteMatches = snippet.match(/(?<!\\)"/g) || [];
      let repaired = snippet;
      if (quoteMatches.length % 2 === 1) repaired += '"';
      repaired += '}';
      try {
        const parsed = JSON.parse(repaired);
        if (parsed && typeof parsed === 'object') {
          parsed._truncated = true;
          return parsed;
        }
      } catch (e) {
        // keep trying smaller cuts
      }
      // For efficiency, jump back to last comma/close-quote instead of -1 each time
      const lastComma = snippet.lastIndexOf(',', cut - 1);
      if (lastComma === -1) break;
      cut = lastComma;
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Grounding metadata
// ──────────────────────────────────────────────────────────────────────────
// Gemini tells us which pages Google fed it and what it searched for. We were
// discarding all of it. These are the raw leads Patch C hands to fetch-contact.
//
// CAVEAT: groundingChunks[].web.uri is usually a vertexaisearch redirect
// wrapper, NOT the publisher URL. web.title is typically the bare domain.
// We return both untouched and let the caller resolve them.
function extractGrounding(geminiResp) {
  const out = { queries: [], sources: [] };
  try {
    const gm = geminiResp?.candidates?.[0]?.groundingMetadata;
    if (!gm) return out;

    if (Array.isArray(gm.webSearchQueries)) {
      out.queries = gm.webSearchQueries.filter(q => typeof q === 'string').slice(0, 10);
    }

    const seen = new Set();
    for (const chunk of (gm.groundingChunks || [])) {
      const w = chunk && chunk.web;
      if (!w || !w.uri || seen.has(w.uri)) continue;
      seen.add(w.uri);
      out.sources.push({ url: w.uri, title: w.title || null });
      if (out.sources.length >= 20) break;
    }
  } catch (e) {
    // Grounding is a bonus, never a reason to fail the request.
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Email validation
// ──────────────────────────────────────────────────────────────────────────
// We do three cheap checks before an email reaches the sales team's export:
//   1. Format   — is it a well-formed address at all?
//   2. Domain   — does the email domain match the company's website domain?
//                 A match is a strong trust signal; a mismatch (e.g. a gmail
//                 address, or a totally different domain) is worth flagging.
//   3. Source   — did the AI say where it actually found the email?
//
// We deliberately do NOT do an MX/DNS lookup here: a domain having mail records
// doesn't prove the specific mailbox exists, and it adds latency per company.

// Reasonably strict but not pedantic. Rejects the obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Normalise what the model actually hands us before judging it. Observed real
// outputs: "mailto:x@y.com", " x@y.com ", "a@y.com, b@y.com", "<x@y.com>",
// "x@y.com." — all of which are recoverable. Without this, a stray space or a
// second address made a good email INVALID and it was dropped on the floor;
// worse, a "mailto:" prefix sailed through both the regex and the domain check
// and exported as TRUSTED.
function cleanEmail(input) {
  if (!input) return null;
  let e = String(input).trim().replace(/^mailto:/i, '');
  const first = e.split(/[,;]|\s+/).filter(Boolean)[0];
  if (!first) return null;
  e = first.replace(/^[<("']+/, '').replace(/[>)"'.,;]+$/, '');
  return e || null;
}

// Strip protocol/www and take the registrable-ish part for comparison.
function domainOf(urlOrEmail) {
  if (!urlOrEmail) return null;
  let host = String(urlOrEmail).trim().toLowerCase();
  if (host.includes('@')) host = host.split('@').pop();
  host = host.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return host || null;
}

// Compare an email's domain against the website's domain. We treat a shared
// last-two-labels (e.g. acme.com.sg vs mail.acme.com.sg) as a match.
function domainsMatch(emailDomain, siteDomain) {
  if (!emailDomain || !siteDomain) return false;
  if (emailDomain === siteDomain) return true;
  const tail = (d) => d.split('.').slice(-3).join('.');  // handles .com.sg
  return tail(emailDomain) === tail(siteDomain)
      || emailDomain.endsWith('.' + siteDomain)
      || siteDomain.endsWith('.' + emailDomain);
}

// Free/personal mailbox providers — an email here is not a company address.
const FREE_MAIL = new Set([
  'gmail.com','yahoo.com','yahoo.com.sg','hotmail.com','outlook.com',
  'live.com','icloud.com','qq.com','163.com','singnet.com.sg'
]);

// Returns { valid, domain_match, free_provider, verdict, note }
// verdict: 'TRUSTED' | 'REVIEW' | 'INVALID' | 'NONE'
function validateEmail(email, website, emailSource) {
  if (!email) {
    return { valid: false, domain_match: false, free_provider: false,
             verdict: 'NONE', note: 'No email found' };
  }
  if (!EMAIL_RE.test(email)) {
    return { valid: false, domain_match: false, free_provider: false,
             verdict: 'INVALID', note: 'Malformed email address' };
  }

  const eDomain = domainOf(email);
  const sDomain = domainOf(website);
  const free = FREE_MAIL.has(eDomain);
  const match = domainsMatch(eDomain, sDomain);

  let verdict, note;
  if (free) {
    verdict = 'REVIEW';
    note = 'Free mailbox provider — not a company domain';
  } else if (match && emailSource === 'company_website') {
    verdict = 'TRUSTED';
    note = 'Domain matches website, found on official site';
  } else if (match) {
    verdict = 'TRUSTED';
    note = 'Email domain matches company website';
  } else if (!sDomain) {
    verdict = 'REVIEW';
    note = 'No website to compare the email domain against';
  } else {
    verdict = 'REVIEW';
    note = `Email domain (${eDomain}) differs from website (${sDomain})`;
  }

  return { valid: true, domain_match: match, free_provider: free, verdict, note };
}

// Normalise the AI response — fill in defaults, ensure expected fields exist.
const OK_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
const OK_METHOD = new Set([
  'uen_on_own_site', 'address_match', 'former_name_match',
  'brand_and_activity_match', 'name_only', 'directory_only', 'unverified',
  // legacy values, still accepted so an older cached prompt cannot break us
  'uen_match'
]);

// Registry copies. A UEN found on one of these is circular evidence: it just
// restates the ACRA record we sent in. Cap such candidates at LOW no matter
// what the model claimed.
const REGISTRY_MIRRORS = [
  'sgpbusiness.com', 'companies.sg', 'opencorporates.com', 'sgcompanyinfo.com',
  'bizfile.gov.sg', 'sgcompanies.co', 'singaporecompanies', 'recordowl.com',
  'entitysearch', 'companylist.sg'
];

function hostOfUrl(u) {
  try { return new URL(String(u).trim()).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return null; }
}

function isRegistryMirror(url) {
  const h = hostOfUrl(url);
  if (!h) return false;
  return REGISTRY_MIRRORS.some(d => h === d || h.endsWith('.' + d) || h.includes(d));
}

// Only http(s). Returns a normalised URL or null.
function normaliseUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!/^[a-z][a-z0-9+.\-]*:/i.test(s)) s = 'https://' + s;
  try {
    const p = new URL(s);
    return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : null;
  } catch (e) { return null; }
}

// The prompt defines the confidence ladder, but a prompt is a request. Gemini
// was observed returning HIGH alongside brand_and_activity_match while its own
// reasoning said the site only "appears to be" official. HIGH is reserved for a
// hard entity link (UEN or registered address on the company's own site); every
// weaker method has a ceiling, enforced here regardless of what the model claims.
const METHOD_MAX_CONFIDENCE = {
  uen_on_own_site: 'HIGH',
  address_match: 'HIGH',
  former_name_match: 'MEDIUM',
  brand_and_activity_match: 'MEDIUM',
  name_only: 'LOW',
  directory_only: 'LOW',
  unverified: 'LOW',
  uen_match: 'MEDIUM'   // legacy: cannot prove it was on their own site
};
const CONF_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };

// Gemini's grounding is snippet-only: it reads Google's index, it never opens
// the page. And it returns no source URLs (groundingMetadata carries only
// searchEntryPoint + webSearchQueries — verified against a live response), so
// any claim it makes about having seen a UEN on a site is UNVERIFIABLE.
//
// HIGH is therefore not something a model can award. It is earned when code
// retrieves the page and finds the UEN or registered address in real HTML,
// with a URL to point at — fetch-contact.js/getBadge() does exactly that.
// Until then, nothing Gemini says exceeds MEDIUM.
const AI_MAX_CONFIDENCE = 'MEDIUM';

function capTo(confidence, ceiling) {
  return CONF_RANK[confidence] > CONF_RANK[ceiling] ? ceiling : confidence;
}

function capConfidence(confidence, method) {
  return capTo(confidence, METHOD_MAX_CONFIDENCE[method] || 'LOW');
}

function normaliseCandidates(parsed) {
  const raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const out = [];
  const seen = new Set();

  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const website = normaliseUrl(c.website);
    if (!website) continue;                 // a candidate with no usable URL is not a candidate
    const host = hostOfUrl(website);
    if (seen.has(host)) continue;
    seen.add(host);

    let confidence = OK_CONFIDENCE.has(c.confidence) ? c.confidence : 'LOW';
    let method = OK_METHOD.has(c.verification_method) ? c.verification_method : 'unverified';
    let note = '';

    // Server-side enforcement of the circular-evidence rule. The prompt asks
    // for this, but the prompt is a request; this is a guarantee.
    if (isRegistryMirror(website)) {
      if (confidence !== 'LOW') note = 'Downgraded: registry-copy directory, not the company website.';
      confidence = 'LOW';
      method = 'directory_only';
    }
    // (a) method-appropriate ceiling — weak evidence cannot claim strong confidence
    const methodCapped = capConfidence(confidence, method);
    if (methodCapped !== confidence) {
      note = (note ? note + ' ' : '') +
        `Downgraded ${confidence} to ${methodCapped}: "${method}" is not a hard entity link.`;
      confidence = methodCapped;
    }
    // (b) AI ceiling — nothing unretrieved and uncitable is ever VERIFIED
    const aiCapped = capTo(confidence, AI_MAX_CONFIDENCE);
    if (aiCapped !== confidence) {
      note = (note ? note + ' ' : '') +
        `Capped at ${aiCapped}: identity claimed from search snippets with no ` +
        `retrievable source. Pending page retrieval.`;
      confidence = aiCapped;
    }

    out.push({
      company_name: String(c.company_name || '').slice(0, 200) || null,
      website,
      confidence,
      verification_method: method,
      reasoning: String(c.reasoning || '').slice(0, 500) + (note ? ' ' + note : '')
    });
    if (out.length >= 3) break;
  }

  out.sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence]);
  return out;
}

// Builds the response. `result` keeps the legacy shape so the existing frontend
// keeps rendering; `candidates` is the new contract Patch C consumes.
function normaliseResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const candidates = normaliseCandidates(parsed);
  const best = candidates[0] || null;

  // Gemini is no longer asked for contacts. If a stray value appears anyway it
  // has no source page behind it, so it does not reach the team.
  const emailCheck = validateEmail(null, null, 'none');

  return {
    // legacy fields — frontend compatibility
    website: best ? best.website : null,
    email: null,
    email_source: 'none',
    email_check: emailCheck,
    phone: null,
    linkedin: null,
    description: String(parsed.description || '').slice(0, 400),
    confidence: best ? best.confidence : 'NONE',
    verification_method: best ? best.verification_method : 'unverified',
    reasoning: best ? best.reasoning : '',

    // new: identity is a separate fact from contact (spec §6)
    identity_confidence: best ? best.confidence : 'NONE',
    identity_reason: best ? best.reasoning : 'No plausible website found.',
    contact_confidence: 'NONE',
    contact_reason: 'Contacts not yet retrieved — deterministic extraction lands in Patch C.',
    candidate_count: candidates.length
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const apiKey = req.api_key;
  const company = req.company;

  if (!apiKey) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Missing api_key' }) };
  }
  if (!company || !company.entity_name) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Missing company.entity_name' }) };
  }

  const prompt = buildPrompt(company);

  // Gemini request body
  // - tools: [{ google_search: {} }] enables web search grounding
  // - temperature: 0.2 — keeps the model factual and consistent
  // - We avoid responseSchema here because it conflicts with google_search
  const body = {
    contents: [
      { role: 'user', parts: [{ text: prompt }] }
    ],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096
    }
  };

  let geminiResp;
  try {
    const r = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errText = await r.text();
      return {
        statusCode: r.status,
        headers: CORS,
        body: JSON.stringify({
          ok: false,
          error: `Gemini API ${r.status}`,
          detail: errText.slice(0, 500)
        })
      };
    }
    geminiResp = await r.json();
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: `Network error: ${e.message}` })
    };
  }

  // Extract the text response from Gemini's nested structure
  const text = geminiResp.candidates?.[0]?.content?.parts
    ?.map(p => p.text || '')
    .join('') || '';

  if (!text) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        error: 'Empty response from Gemini',
        gemini_raw: geminiResp
      })
    };
  }

  const grounding = extractGrounding(geminiResp);

  const parsed = extractJson(text);
  if (!parsed) {
    // Spec §9: malformed JSON must still yield a usable result when we have
    // grounding URLs — those are the leads Patch C needs. Return ok:true with
    // an empty verdict rather than throwing the grounding away.
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        warning: 'json_parse_failed',
        result: {
          website: null, email: null, email_source: 'none',
          email_check: validateEmail(null, null, 'none'),
          phone: null, linkedin: null, description: '',
          confidence: 'NONE', verification_method: 'unverified', reasoning: '',
          identity_confidence: 'NONE',
          identity_reason: 'Gemini returned unparseable JSON; grounding URLs retained.',
          contact_confidence: 'NONE', contact_reason: 'Not retrieved.',
          candidate_count: 0
        },
        candidates: [],
        grounding,
        raw_text: text.slice(0, 1500)
      })
    };
  }

  const result = normaliseResult(parsed);
  if (!result) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        error: 'Unexpected response shape',
        raw_text: text.slice(0, 1500)
      })
    };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      result,
      candidates: normaliseCandidates(parsed),
      grounding
    })
  };
};
