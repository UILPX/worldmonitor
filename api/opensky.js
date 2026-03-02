import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

function getRelayHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const relaySecret = process.env.RELAY_SHARED_SECRET || '';
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req) {
  const startedAt = Date.now();
  const pathname = (() => {
    try { return new URL(req.url).pathname; } catch { return '/api/opensky'; }
  })();
  const finish = (response, detail = '') => {
    const ms = Date.now() - startedAt;
    const state = response.status >= 200 && response.status < 300 ? 'OK' : 'FAIL';
    console.info(`[API][opensky] ${req.method || 'GET'} ${pathname} -> ${response.status} ${state} (${ms}ms)${detail ? ` | ${detail}` : ''}`);
    return response;
  };
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return finish(new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }), 'origin blocked');
  }

  if (req.method === 'OPTIONS') {
    return finish(new Response(null, { status: 204, headers: corsHeaders }), 'preflight');
  }
  if (req.method !== 'GET') {
    return finish(new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }), 'method not allowed');
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return finish(new Response(JSON.stringify({ error: 'WS_RELAY_URL is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }), 'missing WS_RELAY_URL');
  }

  try {
    const requestUrl = new URL(req.url);
    const relayUrl = `${relayBaseUrl}/opensky${requestUrl.search || ''}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
    });

    const body = await response.text();
    const headers = {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
      ...corsHeaders,
    };
    const xCache = response.headers.get('x-cache');
    if (xCache) headers['X-Cache'] = xCache;

    return finish(new Response(body, {
      status: response.status,
      headers,
    }), `upstream=${response.status}`);
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return finish(new Response(JSON.stringify({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
      details: error?.message || String(error),
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }), isTimeout ? 'relay timeout' : 'relay fetch failed');
  }
}
