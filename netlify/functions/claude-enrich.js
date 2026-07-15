// BizTrace V8 — AI Enrichment Proxy (Claude / Anthropic)
//
// Mirrors ai-enrich.js (Gemini) but calls the Anthropic Messages API with the
// server-side web_search tool. Receives a company's ACRA details + the user's
// Anthropic API key, returns structured contact information.
//
// Request body:
//   { api_key: "sk-ant-...", company: { entity_name, uen, ... } }
//
// Response:
//   { ok: true, result: { website, email, phone, linkedin, description,
//                         confidence, verification_method, reasoning } }

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
// Haiku is the cheapest capable model — ideal for keeping enrichment costs low.
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function buildPrompt(company) {
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
Search the web for this specific company. Verify it's the correct one (not a similarly-named entity). Then respond with ONLY a JSON object — no prose before or after, no markdown fences.

VERIFICATION CRITERIA (apply in order):
1. UEN match: best — if a website shows this exact UEN, confidence is HIGH
2. Address match: good — if the website lists the registered Singapore address (postal code or street), confidence is MEDIUM-HIGH
3. Name match only: weak — if only the name matches and you can't verify the address or UEN, confidence is LOW
4. Cannot find: return nulls and confidence "NONE"

OUTPUT FORMAT (exact JSON):
{
  "website": "https://...",
  "email": "info@example.com",
  "email_source": "company_website",
  "phone": "+65 6XXX XXXX",
  "linkedin": "https://...",
  "description": "1-2 sentence summary of what they do",
  "confidence": "HIGH",
  "verification_method": "uen_match",
  "reasoning": "MAXIMUM 2 sentences on how you verified this is the right company. Cite source domain only."
}

For any field you cannot find, use null instead of a value.
confidence must be one of: HIGH, MEDIUM, LOW, NONE
verification_method must be one of: uen_match, address_match, name_only, unverified
email_source must be one of: company_website, directory, linkedin, other, none
  - use "none" whenever email is null

IMPORTANT RULES:
- NEVER invent contact info. If you cannot find an email, return null for email.
- EMAIL HUNTING: look beyond the homepage. Check the company's "Contact" or
  "About" page, business directories (e.g. Yellow Pages Singapore,
  sgpbusiness), and LinkedIn. A general inbox email is valuable to the sales
  team, so search thoroughly before returning null.
- EMAIL HONESTY: only return an email you actually saw published on a real
  page. NEVER guess or construct an email from the domain (do not invent
  "info@<domain>" if you did not actually see it). A correct null is far more
  useful than a fabricated address the team then has to clean up.
- Set email_source to where you actually found the email. If you did not see it
  published anywhere, email must be null and email_source must be "none".
- NEVER assume similarly-named companies are the same. "Axiom Stratix" is NOT
  "Axiom Tech" — if the name doesn't match closely AND you can't confirm via
  UEN or address, set confidence LOW or NONE and say so in reasoning.
- Prefer official sources (company website > government registry > social
  media > directories).
- If the company is "Struck Off", "Cancelled", or "Dissolved", note it briefly
  and set confidence to LOW even if you find historical info.
- Use Singapore phone format with +65 country code.
- Keep description and reasoning SHORT.
- Output ONLY the JSON object.`;
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {}
  let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
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

function normaliseResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const okConf = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
  const okMethod = new Set(['uen_match', 'address_match', 'name_only', 'unverified']);
  const okSource = new Set(['company_website', 'directory', 'linkedin', 'other', 'none']);

  const emailSource = okSource.has(parsed.email_source) ? parsed.email_source : 'none';
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
    confidence: okConf.has(parsed.confidence) ? parsed.confidence : 'NONE',
    verification_method: okMethod.has(parsed.verification_method) ? parsed.verification_method : 'unverified',
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

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
  };

  let apiResp;
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errText = await r.text();
      return {
        statusCode: r.status,
        headers: CORS,
        body: JSON.stringify({
          ok: false,
          error: `Claude API ${r.status}`,
          detail: errText.slice(0, 500)
        })
      };
    }
    apiResp = await r.json();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: `Network error: ${e.message}` }) };
  }

  // Claude returns content as an array of blocks. The web_search results and
  // tool calls appear as their own blocks; the final answer is in text blocks.
  // Concatenate all text blocks to capture the JSON answer.
  const text = Array.isArray(apiResp.content)
    ? apiResp.content.filter(b => b.type === 'text').map(b => b.text || '').join('')
    : '';

  if (!text) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Empty response from Claude', claude_raw: apiResp })
    };
  }

  const parsed = extractJson(text);
  if (!parsed) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Could not parse JSON from Claude response', raw_text: text.slice(0, 1500) })
    };
  }

  const result = normaliseResult(parsed);
  if (!result) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Unexpected response shape', raw_text: text.slice(0, 1500) })
    };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, result }) };
};
