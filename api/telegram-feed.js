// Telegram feed proxy (web)
// Fetches Telegram Early Signals from the Railway relay (stateful MTProto lives there).

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };
const API_VERBOSE_LOGS = process.env.API_VERBOSE_LOGS === 'true';

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
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
    try { return new URL(req.url).pathname; } catch { return '/api/telegram-feed'; }
  })();
  const finish = (response, detail = '') => {
    if (API_VERBOSE_LOGS || response.status >= 400) {
      const ms = Date.now() - startedAt;
      const state = response.status >= 200 && response.status < 300 ? 'OK' : 'FAIL';
      console.error(`[API][telegram-feed] ${req.method || 'GET'} ${pathname} -> ${response.status} ${state} (${ms}ms)${detail ? ` | ${detail}` : ''}`);
    }
    return response;
  };
  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return finish(new Response(null, { status: 204, headers: cors }), 'preflight');
  }

  if (isDisallowedOrigin(req)) {
    return finish(new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: cors }), 'origin blocked');
  }

  let relay = process.env.WS_RELAY_URL;
  if (!relay) {
    return finish(new Response(JSON.stringify({ error: 'WS_RELAY_URL not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...cors },
    }), 'missing WS_RELAY_URL');
  }

  // Guard: WS_RELAY_URL should be HTTP(S) for server-side fetches.
  // If someone accidentally sets a ws:// or wss:// URL, normalize it.
  if (relay.startsWith('wss://')) relay = relay.replace('wss://', 'https://');
  if (relay.startsWith('ws://')) relay = relay.replace('ws://', 'http://');

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const topic = (url.searchParams.get('topic') || '').trim();
  const channel = (url.searchParams.get('channel') || '').trim();

  const relayUrl = new URL('/telegram/feed', relay);
  relayUrl.searchParams.set('limit', String(limit));
  if (topic) relayUrl.searchParams.set('topic', topic);
  if (channel) relayUrl.searchParams.set('channel', channel);

  const fetchHeaders = { 'Accept': 'application/json' };
  const relaySecret = process.env.RELAY_SHARED_SECRET || '';
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    fetchHeaders[relayHeader] = relaySecret;
    fetchHeaders.Authorization = `Bearer ${relaySecret}`;
  }

  try {
    const res = await fetchWithTimeout(relayUrl.toString(), {
      headers: fetchHeaders,
    }, 25000);

    const text = await res.text();
    return finish(new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
        // Short cache. Telegram is near-real-time.
        'Cache-Control': 'public, max-age=10',
        ...cors,
      },
    }), `upstream=${res.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = err && (err.name === 'AbortError' || /aborted/i.test(msg));
    return finish(new Response(JSON.stringify({
      error: isAbort ? 'Telegram relay request timed out' : 'Telegram relay fetch failed',
    }), {
      status: isAbort ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...cors },
    }), isAbort ? 'relay timeout' : 'relay fetch failed');
  }
}
