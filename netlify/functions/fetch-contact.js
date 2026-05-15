// BizTrace V7 — Smart Contact Fetcher
// Logic:
// 1. Receive organic_results from SerpAPI + company name + UEN
// 2. Skip known directory/job/social sites
// 3. Find results whose domain matches the company name
// 4. Fetch that page and extract phone/email
// 5. Verify UEN or name on page for trust badge

// ── Blocklist — domains that are never the company's own site ──────────────
const BLOCKED_DOMAINS = [
  'zoominfo.com', 'linkedin.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'jobstreet.com', 'fastjobs.sg', 'mycareersfuture.gov.sg',
  'glassdoor.com', 'indeed.com', 'gradsingapore.com', 'sgpbusiness.com',
  'bizfile.acra.gov.sg', 'acra.gov.sg', 'yellowpages.com.sg',
  'singpost.com', 'straitstimes.com', 'channelnewsasia.com',
  'businesstimes.com.sg', 'todayonline.com', 'mothership.sg',
  'hungrygowhere.com', 'tripadvisor.com', 'google.com',
  'wikipedia.org', 'crunchbase.com', 'bloomberg.com',
  'sgx.com', 'mas.gov.sg', 'gov.sg', 'iras.gov.sg',
  'sitegiant.sg', 'ecommercemilo.com', 'lazada.com', 'shopee.sg',
  'open.lazada.com', 'seller.lazada.sg',
];

// ── Phone patterns for Singapore ──────────────────────────────────────────
const PHONE_PATTERNS = [
  /(\+65[\s-]?[689]\d{3}[\s-]?\d{4})/g,   // +65 XXXX XXXX
  /(\b[689]\d{3}[\s-]?\d{4}\b)/g,           // 6XXX XXXX / 8XXX XXXX / 9XXX XXXX
  /(\b65[\s-]?[689]\d{3}[\s-]?\d{4}\b)/g,  // 65-XXXX XXXX
];

// ── Email pattern ──────────────────────────────────────────────────────────
const EMAIL_PATTERN = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;

// ── Helpers ────────────────────────────────────────────────────────────────

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isBlocked(url) {
  const domain = getDomain(url);
  return BLOCKED_DOMAINS.some(b => domain === b || domain.endsWith('.' + b));
}

// Extract meaningful keywords from company name for domain matching
// "Lazada Singapore Pte Ltd" → ["lazada"]
// "Lim & Tan Securities Pte Ltd" → ["lim", "tan", "securities"]
function extractKeywords(name) {
  const stopwords = new Set([
    'pte', 'ltd', 'llp', 'lp', 'co', 'corp', 'inc', 'sdn', 'bhd',
    'singapore', 'sg', 'and', 'the', 'of', 'for', 'de', 'van',
    'private', 'limited', 'company', 'enterprise', 'enterprises',
    'group', 'holdings', 'international', 'global', 'asia', 'pacific',
    'services', 'solutions', 'management', 'trading', 'investment',
    '&', '-', '(s)'
  ]);

  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));
}

// Check if a domain plausibly belongs to the company
function domainMatchesCompany(url, companyName) {
  const domain = getDomain(url);
  const keywords = extractKeywords(companyName);
  // At least one keyword must appear in the domain
  return keywords.some(kw => domain.includes(kw));
}

// Extract phone numbers from text
function extractPhone(text) {
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      // Clean up and return first valid match
      const phone = matches[0].replace(/\s+/g, ' ').trim();
      // Sanity check: must be 8 digits (SG numbers)
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 8 || digits.length === 10 || digits.length === 11) {
        return phone;
      }
    }
  }
  return null;
}

// Extract email from text, skip generic/noreply emails
function extractEmail(text) {
  const matches = text.match(EMAIL_PATTERN);
  if (!matches) return null;
  const blocked = ['noreply', 'no-reply', 'donotreply', 'support@', 'info@google', 'example.com'];
  for (const email of matches) {
    const lower = email.toLowerCase();
    if (!blocked.some(b => lower.includes(b))) {
      return email.toLowerCase();
    }
  }
  return null;
}

// Fetch page HTML with timeout
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-SG,en;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 200000); // limit to 200KB
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Determine trust badge
function getBadge(html, uen, companyName) {
  if (!html) return 'UNVERIFIED';
  const lower = html.toLowerCase();
  const uenClean = (uen || '').toLowerCase();
  const nameClean = (companyName || '').toLowerCase();

  if (uenClean && lower.includes(uenClean)) return 'VERIFIED';

  // Check if significant part of company name appears on page
  const keywords = extractKeywords(companyName);
  const matchCount = keywords.filter(kw => lower.includes(kw)).length;
  if (matchCount >= 2) return 'NAME MATCH';
  if (matchCount === 1) return 'LIKELY';

  return 'UNVERIFIED';
}

// ── Main handler ───────────────────────────────────────────────────────────

exports.handler = async function(event) {

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: ''
    };
  }

  // Support both POST (preferred) and GET
  let uen, name, results;
  if (event.httpMethod === 'POST' && event.body) {
    const body = JSON.parse(event.body);
    uen     = body.uen     || '';
    name    = body.name    || '';
    results = body.results || [];
  } else {
    const params = event.queryStringParameters || {};
    uen     = params.uen  || '';
    name    = decodeURIComponent(params.name || '');
    results = JSON.parse(decodeURIComponent(params.results || '[]'));
  }

  if (!results.length) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        badge: 'NO WEB', website: null, phone: null, email: null,
        reason: 'serp_empty',
        debug: { serp_count: 0, after_blocklist: 0, matched: 0, fetches_attempted: 0, fetches_ok: 0 }
      })
    };
  }

  // ── Step 1: Filter out blocked domains ──────────────────────────────────
  const candidates = results.filter(r => r.link && !isBlocked(r.link));
  const blockedDomains = results
    .filter(r => r.link && isBlocked(r.link))
    .map(r => getDomain(r.link));

  if (!candidates.length) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        badge: 'NO WEB', website: null, phone: null, email: null,
        reason: 'all_blocked',
        debug: {
          serp_count: results.length,
          after_blocklist: 0,
          matched: 0,
          fetches_attempted: 0,
          fetches_ok: 0,
          blocked_domains: blockedDomains
        }
      })
    };
  }

  // ── Step 2: Find domain-matched results first ────────────────────────────
  const matched   = candidates.filter(r => domainMatchesCompany(r.link, name));
  const unmatched = candidates.filter(r => !domainMatchesCompany(r.link, name));

  // Try matched first, then unmatched as fallback
  const ordered = [...matched, ...unmatched].slice(0, 5); // max 5 attempts

  let fetchesAttempted = 0;
  let fetchesOk = 0;
  const attemptLog = [];

  for (const result of ordered) {
    const url = result.link;

    // ── Step 3: Try snippet first (free, no fetch needed) ─────────────────
    const snippet = (result.snippet || '') + ' ' + (result.snippet_highlighted_words || []).join(' ');
    const snippetPhone = extractPhone(snippet);
    const snippetEmail = extractEmail(snippet);

    // Only trust snippet contact if domain matches company
    if ((snippetPhone || snippetEmail) && domainMatchesCompany(url, name)) {
      attemptLog.push({ url: getDomain(url), outcome: 'snippet_hit' });
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          badge:   'LIKELY',
          website: url,
          phone:   snippetPhone,
          email:   snippetEmail,
          source:  'snippet',
          reason:  'ok_snippet',
          debug: {
            serp_count: results.length,
            after_blocklist: candidates.length,
            matched: matched.length,
            fetches_attempted: fetchesAttempted,
            fetches_ok: fetchesOk,
            attempts: attemptLog
          }
        })
      };
    }

    // ── Step 4: Fetch the page ────────────────────────────────────────────
    fetchesAttempted++;
    const html = await fetchPage(url);
    if (!html) {
      attemptLog.push({ url: getDomain(url), outcome: 'fetch_failed' });
      continue;
    }
    fetchesOk++;

    const phone = extractPhone(html);
    const email = extractEmail(html);

    if (phone || email) {
      const badge = getBadge(html, uen, name);
      attemptLog.push({ url: getDomain(url), outcome: 'page_hit', badge });
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          badge,
          website: url,
          phone,
          email,
          source: 'page',
          reason: 'ok_page',
          debug: {
            serp_count: results.length,
            after_blocklist: candidates.length,
            matched: matched.length,
            fetches_attempted: fetchesAttempted,
            fetches_ok: fetchesOk,
            attempts: attemptLog
          }
        })
      };
    }

    // Found the right site but no contact info — still report the website
    if (domainMatchesCompany(url, name)) {
      const badge = getBadge(html, uen, name);
      attemptLog.push({ url: getDomain(url), outcome: 'page_no_contact', badge });
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          badge,
          website: url,
          phone:   null,
          email:   null,
          source:  'page',
          reason:  'ok_no_contact',
          debug: {
            serp_count: results.length,
            after_blocklist: candidates.length,
            matched: matched.length,
            fetches_attempted: fetchesAttempted,
            fetches_ok: fetchesOk,
            attempts: attemptLog
          }
        })
      };
    }

    // Page fetched but no contact AND domain doesn't match — log and continue
    attemptLog.push({ url: getDomain(url), outcome: 'no_match_no_contact' });
  }

  // Nothing found — explain why
  let reason = 'no_match';
  if (fetchesAttempted === 0) reason = 'snippet_only_no_match';
  else if (fetchesOk === 0) reason = 'all_fetches_failed';
  else if (matched.length === 0) reason = 'no_domain_matched_company_name';

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      badge: 'NO WEB', website: null, phone: null, email: null,
      reason,
      debug: {
        serp_count: results.length,
        after_blocklist: candidates.length,
        matched: matched.length,
        fetches_attempted: fetchesAttempted,
        fetches_ok: fetchesOk,
        attempts: attemptLog
      }
    })
  };
};