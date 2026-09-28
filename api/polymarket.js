import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';

export const config = { runtime: 'edge' };
const API_VERBOSE_LOGS = process.env.API_VERBOSE_LOGS === 'true';

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

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
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
    try { return new URL(req.url).pathname; } catch { return '/api/polymarket'; }
  })();
  const finish = (response, detail = '') => {
    if (API_VERBOSE_LOGS || response.status >= 400) {
      const ms = Date.now() - startedAt;
      const state = response.status >= 200 && response.status < 300 ? 'OK' : 'FAIL';
      console.error(`[API][polymarket] ${req.method || 'GET'} ${pathname} -> ${response.status} ${state} (${ms}ms)${detail ? ` | ${detail}` : ''}`);
    }
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

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return finish(new Response(JSON.stringify({ error: keyCheck.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }), 'invalid api key');
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return finish(rateLimitResponse, 'rate limited');

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return finish(new Response(JSON.stringify({ error: 'WS_RELAY_URL is not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }), 'missing WS_RELAY_URL');
  }

  try {
    const requestUrl = new URL(req.url);
    const relayUrl = `${relayBaseUrl}/polymarket${requestUrl.search || ''}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({ Accept: 'application/json' }),
    }, 15000);

    const body = await response.text();
    const isSuccess = response.status >= 200 && response.status < 300;
    const headers = {
      'Content-Type': response.headers.get('content-type') || 'application/json',
      'Cache-Control': isSuccess
        ? 'public, max-age=120, s-maxage=300, stale-while-revalidate=900, stale-if-error=1800'
        : 'public, max-age=10, s-maxage=30, stale-while-revalidate=120',
      ...(isSuccess && { 'CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900, stale-if-error=1800' }),
      ...corsHeaders,
    };

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
