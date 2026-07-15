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

  return `You are a research assistant helping a Singapore B2B sales team find contact information for a registered ACRA company.

COMPANY DETAILS:
- Entity name: ${clean(company.entity_name)}
- UEN (unique registration number): ${clean(company.uen)}
- Entity type: ${clean(company.entity_type_description)}
- Status: ${clean(company.entity_status_description)}
- Registered address: ${clean(company.full_address)}
- Primary SSIC (industry): ${clean(company.primary_ssic_code)} - ${clean(company.primary_ssic_description)}

YOUR TASK:
Search the web for this specific company. Verify it's the correct one (not a similarly-named entity). Then return contact information in the EXACT JSON format below — no prose, no markdown fences.

VERIFICATION CRITERIA (apply in order):
1. UEN match: best — if a website shows this exact UEN, confidence is HIGH
2. Address match: good — if the website lists the registered Singapore address (postal code or street), confidence is MEDIUM-HIGH
3. Name match only: weak — if only the name matches and you can't verify the address or UEN, confidence is LOW
4. Cannot find: return nulls and confidence "NONE"

OUTPUT FORMAT (exact JSON, no other text):
{
  "website": "https://...",
  "email": "info@example.com",
  "email_source": "company_website",
  "phone": "+65 6XXX XXXX",
  "linkedin": "https://...",
  "description": "1-2 sentence summary of what they do",
  "confidence": "HIGH",
  "verification_method": "uen_match",
  "reasoning": "MAXIMUM 2 sentences explaining how you verified this is the right company. Be brief. Cite source URLs short — domain only."
}

For any field you cannot find, use null instead of a value.
confidence must be one of: HIGH, MEDIUM, LOW, NONE
verification_method must be one of: uen_match, address_match, name_only, unverified
email_source must be one of: company_website, directory, linkedin, other, none
  - use "none" whenever email is null

IMPORTANT RULES:
- NEVER invent contact info. If you cannot find an email, return null for email.
- EMAIL HUNTING: look beyond the homepage. Check the company's "Contact" or
  "About" page, Singapore business directories, and LinkedIn before giving up.
- EMAIL HONESTY: only return an email you actually SAW published on a real page.
  NEVER guess or construct one from the domain — do not invent "info@<domain>"
  if you did not actually see it written somewhere. A correct null is far more
  useful to the sales team than a fabricated address they must clean up later.
- Set email_source to where you actually found it. If you did not see it
  published anywhere, email must be null and email_source must be "none".
- NEVER assume similarly-named companies are the same. The registered ACRA name
  often differs from the public brand name — if you cannot confirm they are the
  same entity via UEN or address, set confidence LOW and explain in reasoning.
- Prefer official sources (company website > government registry > social media > directories like Yellow Pages).
- If the company is "Struck Off", "Cancelled", or "Dissolved", note this briefly in reasoning and set confidence to LOW even if you find historical info.
- Use Singapore phone format with +65 country code.
- For email, return only a general inquiry email (info@, contact@, enquiries@, sales@) — not a person's personal email.
- Keep description and reasoning SHORT. Total response must be under 800 characters.
- Output ONLY the JSON object. No markdown code fences. No explanations outside the JSON.`;
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
function normaliseResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const allowedConfidence = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
  const allowedMethod = new Set(['uen_match', 'address_match', 'name_only', 'unverified']);
  const allowedSource = new Set(['company_website', 'directory', 'linkedin', 'other', 'none']);

  const confidence = allowedConfidence.has(parsed.confidence) ? parsed.confidence : 'NONE';
  const method = allowedMethod.has(parsed.verification_method) ? parsed.verification_method : 'unverified';
  const emailSource = allowedSource.has(parsed.email_source) ? parsed.email_source : 'none';

  const email = cleanEmail(parsed.email);
  const website = parsed.website || null;
  const emailCheck = validateEmail(email, website, emailSource);
  // A malformed address is worse than none — drop it, and keep email_source
  // consistent with what actually survives into the export.
  const finalEmail = emailCheck.verdict === 'INVALID' ? null : email;

  return {
    website,
    email: finalEmail,
    email_source: finalEmail ? emailSource : 'none',
    email_check: emailCheck,
    phone: parsed.phone || null,
    linkedin: parsed.linkedin || null,
    description: parsed.description || '',
    confidence,
    verification_method: method,
    reasoning: parsed.reasoning || ''
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

  const parsed = extractJson(text);
  if (!parsed) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        error: 'Could not parse JSON from Gemini response',
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
    body: JSON.stringify({ ok: true, result })
  };
};
