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
  // Registry copies: these restate the ACRA record we already hold, so any
  // "match" found on them is circular. Observed in live runs: companies.sg
  // and jctrans.net were both returned as if they were company websites.
  'companies.sg', 'opencorporates.com', 'sgcompanyinfo.com', 'recordowl.com',
  'jctrans.net', 'entitysearch.acra.gov.sg', 'companylist.sg', 'sgcompanies.co',
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

// Generate alternate name forms for fuzzy domain matching.
// "Lim Wei Jie Dental Surgery Pte Ltd" → ["limweijie", "lwj", "limweijiedental", "weijiedental"]
function nameVariants(companyName) {
  const keywords = extractKeywords(companyName);
  const variants = new Set();
  // Full collapsed name
  variants.add(keywords.join(''));
  // Initials
  if (keywords.length >= 2) variants.add(keywords.map(k => k[0]).join(''));
  // First two words joined
  if (keywords.length >= 2) variants.add(keywords[0] + keywords[1]);
  // Last two words joined (often the "brand" part — e.g. "wei jie dental")
  if (keywords.length >= 3) variants.add(keywords.slice(-2).join(''));
  // Each individual keyword (the original strategy)
  for (const k of keywords) variants.add(k);
  // Drop variants shorter than 3 chars (too prone to false positives)
  return [...variants].filter(v => v.length >= 3);
}

// Check how strongly a domain matches the company name. Returns an integer score:
//   2 = strong match (collapsed name or initials present)
//   1 = weak match (single keyword present)
//   0 = no match
function domainMatchStrength(url, companyName) {
  const domain = getDomain(url);
  if (!domain) return 0;
  const keywords = extractKeywords(companyName);
  const variants = nameVariants(companyName);

  // Strong: full collapsed name (e.g. "limweijie") in domain
  const collapsed = keywords.join('');
  if (collapsed.length >= 4 && domain.includes(collapsed)) return 2;

  // Strong: initials match (e.g. "lwj" in domain for "Lim Wei Jie")
  if (keywords.length >= 3) {
    const initials = keywords.map(k => k[0]).join('');
    // Try full initials first, then first 3 chars (for longer names)
    if (initials.length >= 3 && domain.includes(initials)) return 2;
    if (initials.length > 3 && domain.includes(initials.slice(0, 3))) return 2;
  }

  // Weak: any keyword or 2-word variant in domain
  for (const v of variants) {
    if (domain.includes(v)) return 1;
  }
  return 0;
}

// Backward-compat boolean wrapper used by older callsites
function domainMatchesCompany(url, companyName) {
  return domainMatchStrength(url, companyName) > 0;
}

// Extract phone numbers from text
// Matching Singapore's number FORMAT does not make a number real. Observed
// live: trellisstrategies.org publishes "99999999", which is a placeholder,
// and it was returned to the sales team as a phone number.
function isPlaceholderPhone(phone) {
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('65') && d.length === 10) d = d.slice(2);   // strip country code
  if (d.length !== 8) return false;
  if (/^(\d)\1{7}$/.test(d)) return true;            // 99999999, 88888888, 66666666
  if (d === '12345678' || d === '87654321') return true;
  if (d === '61234567' || d === '81234567' || d === '91234567') return true;
  if (/^(\d\d)\1{3}$/.test(d)) return true;          // 12121212
  return false;
}

function extractPhone(text) {
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (!matches) continue;
    // Walk every match, not just the first — the first may be a placeholder
    // while a real number sits further down the page.
    for (const raw of matches) {
      const phone = raw.replace(/\s+/g, ' ').trim();
      const digits = phone.replace(/\D/g, '');
      if (digits.length !== 8 && digits.length !== 10 && digits.length !== 11) continue;
      if (isPlaceholderPhone(phone)) continue;
      return phone;
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
// Netlify's practical ceiling is ~10s for the whole invocation. fetchPage used
// a fixed 8s timeout while the caller looped over 5 candidates — 40s worst
// case. It survived because most pages answer fast, but Patch C adds a new
// caller, so the budget is now explicit and enforced.
const TOTAL_FETCH_BUDGET_MS = 7500;   // all fetching, leaves ~2.5s of headroom
const PER_PAGE_TIMEOUT_MS   = 3500;   // lowered: one slow page must not eat the crawl
const MIN_TIME_TO_TRY_MS    = 1200;   // below this, stop rather than start a doomed fetch
const MAX_INTERNAL_PAGES    = 2;      // landing page + up to 2 internal = 3 max

async function fetchPage(url, budgetMs) {
  const controller = new AbortController();
  const ms = Math.max(500, Math.min(PER_PAGE_TIMEOUT_MS, budgetMs || PER_PAGE_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), ms);
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
    if (!res.ok) return { html: null, error: 'http_' + res.status };
    const text = await res.text();
    return { html: text.slice(0, 200000), error: null }; // limit to 200KB
  } catch (e) {
    clearTimeout(timer);
    // Distinguish "this domain does not exist" from "the site would not talk
    // to us". Confirmed live: production-hasu.com returns NXDOMAIN — Gemini
    // invented it. An invented domain is not a lead to review; it is nothing.
    const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ERR_NAME_NOT_RESOLVED') {
      return { html: null, error: 'dns_nxdomain' };
    }
    if (e && e.name === 'AbortError') return { html: null, error: 'timeout' };
    return { html: null, error: 'network_' + (code || (e && e.name) || 'unknown') };
  }
}

// Determine trust badge
function getBadge(html, uen, companyName, postalCode) {
  if (!html) return 'UNVERIFIED';
  const lower = html.toLowerCase();
  const uenClean = (uen || '').toLowerCase();

  // A UEN on the page is conclusive.
  if (uenClean && lower.includes(uenClean)) return 'VERIFIED';

  // So is the registered postal code. A Singapore postal code identifies one
  // building, and companies publish their address far more often than their
  // UEN — so in practice this is the realistic route to VERIFIED. Require the
  // 6 digits to stand alone, so we don't match a phone number or an order id.
  const pc = String(postalCode || '').replace(/\D/g, '');
  if (pc.length === 6 && new RegExp('(?:^|[^0-9])' + pc + '(?:[^0-9]|$)').test(lower)) {
    return 'VERIFIED';
  }

  // Check if significant part of company name appears on page
  const keywords = extractKeywords(companyName);
  const matchCount = keywords.filter(kw => lower.includes(kw)).length;
  if (matchCount >= 2) return 'NAME MATCH';
  if (matchCount === 1) return 'LIKELY';

  return 'UNVERIFIED';
}

// ── Internal page discovery ────────────────────────────────────────────────
// SG SME emails are rarely on the homepage — they live on /contact or /about.
// FIRSTCALL QA and PICTET both returned "page reached, no contact" for exactly
// this reason. We follow a SMALL, same-site, contact-shaped set of links only.

const SECOND_LEVEL = new Set(['com', 'net', 'org', 'edu', 'gov', 'co']);

// acme.com.sg -> acme.com.sg ; mail.acme.com.sg -> acme.com.sg ; blog.x.com -> x.com
function registrable(host) {
  const p = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  if (p.length <= 2) return p.join('.');
  if (SECOND_LEVEL.has(p[p.length - 2])) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

const CONTACT_HINT_RE = /(contact|about|enquir|location|support|reach|get-in-touch|impressum)/i;
const STRONG_HINT_RE  = /(contact|enquir|get-in-touch|reach)/i;

function discoverInternalLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch (e) { return []; }
  const found = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,150}?)<\/a>/gi;
  let m, guard = 0;
  while ((m = re.exec(html)) !== null && guard++ < 400) {
    let abs;
    try { abs = new URL(m[1], base); } catch (e) { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    if (registrable(abs.hostname) !== registrable(base.hostname)) continue;  // same site only
    abs.hash = '';
    if (abs.href === baseUrl) continue;
    const hay = abs.pathname + ' ' + m[2].replace(/<[^>]*>/g, ' ');
    if (!CONTACT_HINT_RE.test(hay)) continue;
    const score = STRONG_HINT_RE.test(hay) ? 3 : /about/i.test(hay) ? 2 : 1;
    if (!found.has(abs.href) || found.get(abs.href) < score) found.set(abs.href, score);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

// ── Scored contact selection ───────────────────────────────────────────────
// The old extractEmail returned the FIRST regex match that was not blocklisted.
// That picks up analytics addresses, the web developer's inbox, and template
// placeholders. It also blocked support@ outright, which for many SMEs is the
// real inbox. Score instead, and take the best.

const GENERIC_LOCALS = ['enquiries', 'enquiry', 'sales', 'info', 'contact', 'hello',
                        'office', 'general', 'ask', 'admin', 'marketing', 'reception',
                        'support', 'mail'];
const BAD_LOCAL_RE = /^(noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|abuse|webmaster|hostmaster|root|bounce|sentry|wordpress)/i;
const BAD_EMAIL_RE = /(example\.(com|org|net)|yourdomain|your-domain|domain\.com|yourcompany|sentry\.io|wixpress\.com|godaddy|squarespace|shopify|wordpress\.com|w3\.org|schema\.org|\.png|\.jpg|\.jpeg|\.gif|\.webp|@2x|@3x)/i;
const FREE_MAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'yahoo.com.sg', 'hotmail.com',
                                   'outlook.com', 'live.com', 'icloud.com', 'qq.com', '163.com']);

function selectEmail(html, pageUrl) {
  const site = registrable(getDomain(pageUrl));
  const seen = new Map();   // email -> fromMailto

  // mailto: is the strongest signal — a human deliberately published it.
  const mt = /mailto:([^"'?>\s&]+)/gi;
  let m;
  while ((m = mt.exec(html)) !== null) {
    let e;
    try { e = decodeURIComponent(m[1]); } catch (err) { e = m[1]; }
    e = e.toLowerCase().trim();
    if (e) seen.set(e, true);
  }
  for (const p of (html.match(EMAIL_PATTERN) || [])) {
    const e = p.toLowerCase();
    if (!seen.has(e)) seen.set(e, false);
  }

  let best = null;
  for (const [email, fromMailto] of seen) {
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) continue;
    const at = email.lastIndexOf('@');
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (BAD_LOCAL_RE.test(local) || BAD_EMAIL_RE.test(email)) continue;

    let score = 0;
    if (fromMailto) score += 100;
    if (registrable(domain) === site) score += 60;          // their own domain
    else if (FREE_MAIL_DOMAINS.has(domain)) score += 5;      // an SME may really use gmail
    else score -= 40;                                        // someone else's domain
    const gi = GENERIC_LOCALS.indexOf(local);
    if (gi >= 0) score += 35 - gi;                           // enquiries@ > sales@ > info@ > ...
    else if (GENERIC_LOCALS.some(g => local.startsWith(g))) score += 10;
    if (!best || score > best.score) best = { email, score, fromMailto };
  }
  return best && best.score > 0 ? best : null;
}

const PHONE_LABEL_RE = /(tel|phone|call|contact|office|hotline|mobile|sales|enquir|fax)/i;

function selectPhone(html) {
  // Real tel: LINKS first — deliberately published. Must be an href: a bare
  // /tel:/ also matches the label "Tel:" in prose, and even "Hotel:".
  const tl = /href\s*=\s*["']tel:([+0-9\s\-()]{7,20})["']/gi;
  let m;
  while ((m = tl.exec(html)) !== null) {
    const phone = m[1].replace(/\s+/g, ' ').trim();
    const d = phone.replace(/\D/g, '');
    if ((d.length === 8 || d.length === 10 || d.length === 11) && !isPlaceholderPhone(phone)) {
      return { phone, fromTel: true };
    }
  }
  // then a number sitting next to a phone-ish label
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0;
    let mm;
    while ((mm = pattern.exec(html)) !== null) {
      const phone = mm[0].replace(/\s+/g, ' ').trim();
      const d = phone.replace(/\D/g, '');
      if (d.length !== 8 && d.length !== 10 && d.length !== 11) continue;
      if (isPlaceholderPhone(phone)) continue;
      const ctx = html.slice(Math.max(0, mm.index - 80), mm.index + 80);
      if (PHONE_LABEL_RE.test(ctx)) return { phone, fromTel: false, labelled: true };
    }
  }
  const p = extractPhone(html);   // last resort: any non-placeholder number
  return p ? { phone: p, fromTel: false, labelled: false } : null;
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

  const startedAt = Date.now();
  const timeLeft = () => TOTAL_FETCH_BUDGET_MS - (Date.now() - startedAt);

  // Support both POST (preferred) and GET
  let uen, name, results, postalCode = null;
  if (event.httpMethod === 'POST' && event.body) {
    const body = JSON.parse(event.body);
    uen     = body.uen     || '';
    name    = body.name    || '';
    results = body.results || [];
    postalCode = body.postal_code || null;
  } else {
    const params = event.queryStringParameters || {};
    uen     = params.uen  || '';
    name    = decodeURIComponent(params.name || '');
    postalCode = params.postal_code || null;
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

  // ── Step 2: Score candidates by match strength + cross-result frequency ──
  // Count how often each domain appears across all candidates — a domain that
  // appears multiple times in the search results is more likely to be the
  // company's real site, even if the name doesn't match.
  const domainFreq = {};
  for (const r of candidates) {
    const d = getDomain(r.link);
    if (d) domainFreq[d] = (domainFreq[d] || 0) + 1;
  }

  const scored = candidates.map((r, i) => {
    const d = getDomain(r.link);
    const strength = domainMatchStrength(r.link, name);  // 0/1/2
    const freq = domainFreq[d] || 1;
    // Score: strength weighted heaviest, then frequency, then original SERP rank
    const score = (strength * 100) + (freq >= 3 ? 50 : freq >= 2 ? 20 : 0) + (10 - i);
    return { r, d, strength, freq, score };
  }).sort((a, b) => b.score - a.score);

  const matched   = scored.filter(s => s.strength > 0).map(s => s.r);
  const unmatched = scored.filter(s => s.strength === 0).map(s => s.r);
  const ordered = scored.slice(0, 5).map(s => s.r);  // top 5 by score

  // Top 3 candidates returned in every response — used as "candidate sites"
  // fallback in the UI when no high-confidence match found
  const topCandidates = scored.slice(0, 3).map(s => ({
    url: s.r.link,
    domain: s.d,
    title: s.r.title || s.d,
    snippet: (s.r.snippet || '').slice(0, 200),
    strength: s.strength,
    freq: s.freq
  }));

  let fetchesAttempted = 0;
  let fetchesOk = 0;
  let dnsFailures = 0;
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
          candidates: topCandidates,
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

    // ── Step 4: Crawl the landing page, then a couple of internal pages ───
    if (timeLeft() < MIN_TIME_TO_TRY_MS) {
      attemptLog.push({ url: getDomain(url), outcome: 'skipped_out_of_time' });
      break;
    }

    const pagesChecked = [];
    let bestEmail = null, emailUrl = null;
    let bestPhone = null, phoneUrl = null;
    let siteBadge = 'UNVERIFIED', identityUrl = null;
    const queue = [url];
    let internalAdded = 0;

    while (queue.length && timeLeft() >= MIN_TIME_TO_TRY_MS &&
           pagesChecked.length < 1 + MAX_INTERNAL_PAGES) {
      const pageUrl = queue.shift();
      fetchesAttempted++;
      const page = await fetchPage(pageUrl, timeLeft());
      const html = page && page.html;
      if (!html) {
        const why = (page && page.error) || 'unknown';
        if (why === 'dns_nxdomain') dnsFailures++;
        attemptLog.push({ url: pageUrl, outcome: 'fetch_failed', error: why });
        continue;
      }
      fetchesOk++;
      pagesChecked.push(pageUrl);

      // Identity: the UEN on a retrieved page is the only thing that earns
      // VERIFIED. Record WHICH page proved it.
      const b = getBadge(html, uen, name, postalCode);
      if (b === 'VERIFIED' && siteBadge !== 'VERIFIED') { siteBadge = 'VERIFIED'; identityUrl = pageUrl; }
      else if (siteBadge === 'UNVERIFIED' && b !== 'UNVERIFIED') { siteBadge = b; identityUrl = identityUrl || pageUrl; }

      const e = selectEmail(html, pageUrl);
      if (e && (!bestEmail || e.score > bestEmail.score)) { bestEmail = e; emailUrl = pageUrl; }
      const p = selectPhone(html);
      if (p && (!bestPhone || (p.fromTel && !bestPhone.fromTel))) { bestPhone = p; phoneUrl = pageUrl; }

      // Queue contact-shaped links from the landing page only — never recurse.
      if (pagesChecked.length === 1) {
        for (const link of discoverInternalLinks(html, pageUrl)) {
          if (internalAdded >= MAX_INTERNAL_PAGES) break;
          queue.push(link); internalAdded++;
        }
      }

      // Enough evidence: a mailto on their own domain plus a phone.
      if (bestEmail && bestEmail.score >= 150 && bestPhone) break;
    }

    if (!pagesChecked.length) continue;   // nothing retrievable for this candidate

    if (bestEmail || bestPhone) {
      attemptLog.push({ url: getDomain(url), outcome: 'page_hit', badge: siteBadge, pages: pagesChecked.length });
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          badge: siteBadge,
          website: url,
          phone: bestPhone ? bestPhone.phone : null,
          email: bestEmail ? bestEmail.email : null,
          source: 'page',
          reason: 'ok_page',
          // Provenance, per field. A contact with no source URL is not a contact.
          email_source_url: bestEmail ? emailUrl : null,
          phone_source_url: bestPhone ? phoneUrl : null,
          identity_source_url: identityUrl,
          pages_checked: pagesChecked,
          candidates: topCandidates,
          debug: {
            serp_count: results.length,
            after_blocklist: candidates.length,
            matched: matched.length,
            fetches_attempted: fetchesAttempted,
            fetches_ok: fetchesOk,
            dns_failures: dnsFailures,
            attempts: attemptLog,
            elapsed_ms: Date.now() - startedAt,
            email_score: bestEmail ? bestEmail.score : null,
            phone_from_tel: bestPhone ? !!bestPhone.fromTel : null
          }
        })
      };
    }

    // Reached the site but it publishes no contact anywhere we looked.
    if (domainMatchesCompany(url, name)) {
      attemptLog.push({ url: getDomain(url), outcome: 'page_no_contact', badge: siteBadge, pages: pagesChecked.length });
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          badge: siteBadge,
          website: url,
          phone: null,
          email: null,
          source: 'page',
          reason: 'ok_no_contact',
          email_source_url: null,
          phone_source_url: null,
          identity_source_url: identityUrl,
          pages_checked: pagesChecked,
          candidates: topCandidates,
          debug: {
            serp_count: results.length,
            after_blocklist: candidates.length,
            matched: matched.length,
            fetches_attempted: fetchesAttempted,
            fetches_ok: fetchesOk,
            dns_failures: dnsFailures,
            attempts: attemptLog,
            elapsed_ms: Date.now() - startedAt
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
  // Every candidate domain failed DNS ⇒ the model made the URL up. That is a
  // different fact from "the site blocked us", and deserves a different answer.
  else if (fetchesOk === 0 && dnsFailures > 0 && dnsFailures === fetchesAttempted)
    reason = 'domain_not_found';
  else if (fetchesOk === 0) reason = 'all_fetches_failed';
  else if (matched.length === 0) reason = 'no_domain_matched_company_name';

  // If we have candidates but couldn't verify any of them, surface as UNVERIFIED
  // (with candidates for manual pick) instead of NO WEB — distinguishes "tried
  // and failed" from "couldn't try at all"
  const finalBadge = topCandidates.length > 0 ? 'UNVERIFIED' : 'NO WEB';

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      badge: finalBadge, website: null, phone: null, email: null,
      reason,
      candidates: topCandidates,
      debug: {
        serp_count: results.length,
        after_blocklist: candidates.length,
        matched: matched.length,
        fetches_attempted: fetchesAttempted,
        fetches_ok: fetchesOk,
        dns_failures: dnsFailures,
        attempts: attemptLog,
        elapsed_ms: Date.now() - startedAt,
        out_of_time: timeLeft() < MIN_TIME_TO_TRY_MS
      }
    })
  };
};