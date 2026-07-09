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

// Gemini 2.5 Flash-Lite: free tier gives 15 RPM / 1,000 requests-per-day,
// versus only ~20/day on standard Flash. Quality is slightly lower but more
// than sufficient for company contact lookup, and it still supports Google
// Search grounding. If a region lacks grounding on Flash-Lite, fall back to
// 'gemini-2.5-flash' or 'gemini-3-flash'.
const GEMINI_MODEL = 'Gemini 2.5 Flash Lite';
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

IMPORTANT RULES:
- NEVER invent contact info. If you cannot find an email, return null for email.
- NEVER assume similarly-named companies are the same.
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

// Normalise the AI response — fill in defaults, ensure expected fields exist.
function normaliseResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const allowedConfidence = new Set(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
  const allowedMethod = new Set(['uen_match', 'address_match', 'name_only', 'unverified']);

  const confidence = allowedConfidence.has(parsed.confidence) ? parsed.confidence : 'NONE';
  const method = allowedMethod.has(parsed.verification_method) ? parsed.verification_method : 'unverified';

  return {
    website: parsed.website || null,
    email: parsed.email || null,
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
