// BizTrace V7 — SerpAPI proxy
// Uses native fetch (Node 18+) instead of https module

exports.handler = async function(event) {

  // CORS preflight
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

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const params = event.queryStringParameters || {};
  const apiKey = params.api_key;
  const q      = params.q;

  if (!apiKey || !q) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing api_key or q parameter' })
    };
  }

  const enhancedQuery = q + ' (inurl:contact OR "contact us")';

  const sp = new URLSearchParams({
    q:       enhancedQuery,
    gl:      'sg',
    hl:      'en',
    num:     '10',
    api_key: apiKey,
    engine:  'google_light'
  });

  const url = `https://serpapi.com/search.json?${sp.toString()}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.error })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        organic_results: data.organic_results || [],
        knowledge_graph: data.knowledge_graph || null,
        credits_used: 1
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};