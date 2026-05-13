// Netlify function — fetches a company website and verifies the match
// against the supplied UEN and company name.
//
// GET /.netlify/functions/fetch-contact?url=https://example.com.sg
//                                       &uen=201624862C
//                                       &name=ALT%20CAPITAL%20PTE.%20LTD.
//
// Returns:
// {
//   success: true,
//   phones: ["+65 6123 4567"],
//   emails: ["info@example.com.sg"],
//   verification: "UEN_MATCH" | "NAME_MATCH" | "LIKELY" | "UNVERIFIED" | "MISMATCH",
//   verificationDetail: "UEN 201624862C found on contact page",
//   contactUrl: "https://example.com.sg/contact",
// }

const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 6000;
const MAX_BYTES     = 500000;

// Regex patterns
const PHONE_RE = /(?:\+?65[\s\-]?)?[3689]\d{3}[\s\-]?\d{4}/g;
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,30}/g;

// Singapore UEN patterns:
//   yyyy nnnnn X  (standard company UEN)  e.g. 201624862C
//   Sxx nnnnn X    (societies/charities)   e.g. S70SS0015K
//   Txx XX nnnn X  (Tnn-prefix entities)   e.g. T13SM0002A
// For this use case we only match the standard company pattern since we're
// enriching filtered ACRA Local Companies.
const UEN_IN_TEXT_RE = /\b((?:19|20)\d{2}\d{5}[A-Z]|[ST]\d{2}[A-Z]{2}\d{4}[A-Z])\b/gi;

// Contact-page link patterns
const CONTACT_LINK_RE = /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*(?:contact|reach us|get in touch|contact us)[^<]*<\/a>/gi;
const CONTACT_URL_RE  = /<a[^>]+href=["']([^"'#]*(?:contact|contact-us|contactus|reach-us|get-in-touch)[^"']*)["']/gi;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fetching with timeout + redirect following
// ─────────────────────────────────────────────────────────────────────────────
function fetchPage(urlStr) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); }
    catch { return reject(new Error('Invalid URL')); }

    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      timeout: FETCH_TIMEOUT,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-SG,en;q=0.9',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, urlStr).toString() });
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ct = (res.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
        res.resume();
        return reject(new Error('Not HTML'));
      }

      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString('utf-8');
        if (body.length > MAX_BYTES) {
          res.destroy();
          resolve({ html: body, finalUrl: urlStr });
        }
      });
      res.on('end', () => resolve({ html: body, finalUrl: urlStr }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchFollow(urlStr, hops = 3) {
  let current = urlStr;
  for (let i = 0; i <= hops; i++) {
    const r = await fetchPage(current);
    if (r.redirect) { current = r.redirect; continue; }
    return r;
  }
  throw new Error('Too many redirects');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML processing
// ─────────────────────────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

function findContactPageUrl(homepageUrl, html) {
  const candidates = new Set();
  let m;

  const p1 = new RegExp(CONTACT_LINK_RE.source, CONTACT_LINK_RE.flags);
  while ((m = p1.exec(html)) !== null) candidates.add(m[1]);

  const p2 = new RegExp(CONTACT_URL_RE.source, CONTACT_URL_RE.flags);
  while ((m = p2.exec(html)) !== null) candidates.add(m[1]);

  // Common default paths
  ['/contact', '/contact-us', '/contactus', '/get-in-touch'].forEach(p => candidates.add(p));

  let baseHost;
  try { baseHost = new URL(homepageUrl).hostname; } catch { return null; }

  for (const raw of candidates) {
    try {
      const abs = new URL(raw, homepageUrl).toString();
      const absHost = new URL(abs).hostname;
      if (absHost === baseHost) return abs;
    } catch { /* skip */ }
  }
  return null;
}

function extractMailtoTel(html) {
  const phones = [];
  const emails = [];
  const mt = /mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,30})/gi;
  const tl = /tel:([+\d\s\-()]{7,})/gi;
  let m;
  while ((m = mt.exec(html)) !== null) emails.push(m[1].toLowerCase());
  while ((m = tl.exec(html)) !== null) phones.push(m[1]);
  return { phones, emails };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification — check if the page actually belongs to the given UEN/company
// ─────────────────────────────────────────────────────────────────────────────
function normalizeName(name) {
  // Strip corporate suffixes and punctuation; collapse whitespace; lowercase.
  return (name || '')
    .toLowerCase()
    .replace(/\b(pte\.?\s*ltd\.?|private\s+limited|pte\s+ltd|limited|llp|llc|inc\.?|corp\.?|holdings?|pvt\.?\s*ltd\.?)\b/gi, '')
    .replace(/[.,'"&()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifyMatch(combinedText, expectedUen, expectedName) {
  const text = combinedText.toLowerCase();
  const result = { verification: 'UNVERIFIED', detail: 'No name or UEN found on page' };

  // STEP 1 — Find every UEN mentioned in the text
  const uensInPage = new Set();
  let m;
  const uenRe = new RegExp(UEN_IN_TEXT_RE.source, UEN_IN_TEXT_RE.flags);
  while ((m = uenRe.exec(combinedText)) !== null) {
    uensInPage.add(m[1].toUpperCase());
  }

  // STEP 2 — UEN match (strongest)
  if (expectedUen && uensInPage.has(expectedUen.toUpperCase())) {
    return { verification: 'UEN_MATCH', detail: `UEN ${expectedUen} found in page` };
  }

  // STEP 3 — UEN mismatch (a DIFFERENT UEN appears but not ours)
  if (expectedUen && uensInPage.size > 0 && !uensInPage.has(expectedUen.toUpperCase())) {
    // Be careful — a page might list many UENs (e.g. case studies, clients).
    // Only flag as mismatch if there's a single UEN and it's clearly "ours" (footer, about page)
    // For now, this is a soft signal — mark unverified but note the mismatch
    if (uensInPage.size === 1) {
      const otherUen = [...uensInPage][0];
      result.detail = `Page lists UEN ${otherUen}, not ${expectedUen}`;
      // Don't set verification=MISMATCH yet — continue to name check
    }
  }

  // STEP 4 — Full normalized name match
  const normalizedName = normalizeName(expectedName);
  if (normalizedName && normalizedName.length >= 3) {
    // Full match — the whole normalized name string appears in the text
    if (text.includes(normalizedName)) {
      return { verification: 'NAME_MATCH', detail: `Company name "${expectedName}" found in page` };
    }

    // Token-based partial match: if all the distinctive words appear (in any order)
    const tokens = normalizedName.split(/\s+/).filter(t => t.length >= 3);
    if (tokens.length > 0) {
      const allFound = tokens.every(t => text.includes(t));
      if (allFound) {
        return { verification: 'LIKELY', detail: `All name tokens (${tokens.join(', ')}) found on page` };
      }

      // First distinctive token appears — softer signal
      if (tokens[0] && text.includes(tokens[0]) && tokens[0].length >= 4) {
        return { verification: 'LIKELY', detail: `Partial name match: "${tokens[0]}"` };
      }
    }
  }

  // STEP 5 — No match: if page had a DIFFERENT UEN only, upgrade to MISMATCH
  if (expectedUen && uensInPage.size === 1 && !uensInPage.has(expectedUen.toUpperCase())) {
    return { verification: 'MISMATCH', detail: result.detail };
  }

  return result;  // UNVERIFIED
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAndVerify(homepageUrl, expectedUen, expectedName) {
  let homepage;
  try {
    homepage = await fetchFollow(homepageUrl);
  } catch (e) {
    return { success: false, error: `homepage: ${e.message}` };
  }

  const homepageHtml = homepage.html;

  // Skip if the page is too small or a JS-required SPA shell
  if (homepageHtml.length < 500 || /please enable javascript/i.test(homepageHtml)) {
    return { success: false, error: 'SPA or empty page' };
  }

  // Try fetching the contact page too
  let contactHtml = '';
  let contactUrl = null;
  const candidate = findContactPageUrl(homepage.finalUrl, homepageHtml);
  if (candidate && candidate !== homepage.finalUrl) {
    try {
      const c = await fetchFollow(candidate);
      contactHtml = c.html;
      contactUrl = c.finalUrl;
    } catch { /* ignore, still have homepage */ }
  }

  // Combine both pages for extraction
  const combinedHtml = homepageHtml + ' ' + contactHtml;
  const combinedText = htmlToText(combinedHtml);

  // Verify the site matches the expected UEN/name
  const verification = verifyMatch(combinedHtml + ' ' + combinedText, expectedUen, expectedName);

  // Extract contact info
  const fromLinks = extractMailtoTel(combinedHtml);
  const textPhones = combinedText.match(PHONE_RE) || [];
  const textEmails = combinedText.match(EMAIL_RE) || [];

  const phones = [...new Set([...fromLinks.phones, ...textPhones])];
  const emails = [...new Set([...fromLinks.emails, ...textEmails].map(e => e.toLowerCase()))];

  return {
    success: true,
    phones,
    emails,
    contactUrl,
    homepageUrl: homepage.finalUrl,
    pageSource: contactUrl ? 'contact-page' : 'homepage-only',
    verification: verification.verification,
    verificationDetail: verification.detail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const params = event.queryStringParameters || {};
  const url  = params.url;
  const uen  = params.uen  || '';
  const name = params.name || '';

  if (!url) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing url parameter' })
    };
  }

  try {
    const result = await fetchAndVerify(url, uen, name);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message, success: false })
    };
  }
};
