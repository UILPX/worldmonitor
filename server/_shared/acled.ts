/**
 * Shared ACLED API fetch with Redis caching.
 *
 * Three endpoints call ACLED independently (risk-scores, unrest-events,
 * acled-events) with overlapping queries. This shared layer ensures
 * identical queries hit Redis instead of making redundant upstream calls.
 */

declare const process: { env: Record<string, string | undefined> };

import { CHROME_UA } from './constants';
import { cachedFetchJson } from './redis';

const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
const ACLED_OAUTH_URL = 'https://acleddata.com/oauth/token';
const ACLED_CACHE_TTL = 900; // 15 min — matches ACLED rate-limit window
const ACLED_TIMEOUT_MS = 15_000;
const ACLED_TOKEN_REFRESH_SKEW_MS = 60_000;
const ACLED_DEFAULT_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

interface AcledAuthState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
  initializedFromEnv: boolean;
  refreshing: Promise<string | null> | null;
}

const acledAuthState: AcledAuthState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  initializedFromEnv: false,
  refreshing: null,
};

export interface AcledRawEvent {
  event_id_cnty?: string;
  event_type?: string;
  sub_event_type?: string;
  country?: string;
  location?: string;
  latitude?: string;
  longitude?: string;
  event_date?: string;
  fatalities?: string;
  source?: string;
  actor1?: string;
  actor2?: string;
  admin1?: string;
  notes?: string;
  tags?: string;
}

interface FetchAcledOptions {
  eventTypes: string;
  startDate: string;
  endDate: string;
  country?: string;
  limit?: number;
}

interface AcledOauthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
  message?: string;
}

function readAcledPasswordGrantCredentials(): { username: string; password: string; clientId: string } | null {
  const username = (process.env.ACLED_EMAIL || process.env.ACLED_USERNAME || '').trim();
  const password = (process.env.ACLED_PASSWORD || '').trim();
  if (!username || !password) return null;
  return {
    username,
    password,
    clientId: (process.env.ACLED_CLIENT_ID || 'acled').trim() || 'acled',
  };
}

function initializeAcledAuthStateFromEnv(): void {
  if (acledAuthState.initializedFromEnv) return;
  acledAuthState.initializedFromEnv = true;

  const envToken = (process.env.ACLED_ACCESS_TOKEN || '').trim();
  const envRefreshToken = (process.env.ACLED_REFRESH_TOKEN || '').trim();
  if (!envToken) return;

  acledAuthState.accessToken = envToken;
  acledAuthState.refreshToken = envRefreshToken || null;
  // When OAuth creds are present we treat env token as renewable and assume
  // a default lifetime until the first successful refresh.
  const hasPasswordGrantCreds = Boolean(readAcledPasswordGrantCredentials());
  acledAuthState.expiresAt = hasPasswordGrantCreds ? Date.now() + ACLED_DEFAULT_TOKEN_TTL_MS : Number.POSITIVE_INFINITY;
}

function resolveTokenExpiryMs(expiresInRaw: number | string | undefined): number {
  const parsed = typeof expiresInRaw === 'number'
    ? expiresInRaw
    : typeof expiresInRaw === 'string'
      ? Number.parseInt(expiresInRaw, 10)
      : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  return ACLED_DEFAULT_TOKEN_TTL_MS;
}

async function requestAcledToken(params: URLSearchParams): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number }> {
  const resp = await fetch(ACLED_OAUTH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CHROME_UA,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(ACLED_TIMEOUT_MS),
  });

  const raw = await resp.text();
  let payload: AcledOauthTokenResponse = {};
  try {
    payload = JSON.parse(raw) as AcledOauthTokenResponse;
  } catch {
    // Non-JSON body from upstream; handled below.
  }

  if (!resp.ok) {
    const reason = payload.error_description || payload.error || payload.message || raw || `HTTP ${resp.status}`;
    throw new Error(`ACLED OAuth error: ${reason}`);
  }

  const accessToken = (payload.access_token || '').trim();
  if (!accessToken) {
    throw new Error('ACLED OAuth response missing access_token');
  }

  const refreshToken = (payload.refresh_token || '').trim() || null;
  const expiresAt = Date.now() + resolveTokenExpiryMs(payload.expires_in);
  return { accessToken, refreshToken, expiresAt };
}

async function refreshAcledToken(force: boolean): Promise<string | null> {
  initializeAcledAuthStateFromEnv();

  if (!force && acledAuthState.accessToken && Date.now() < (acledAuthState.expiresAt - ACLED_TOKEN_REFRESH_SKEW_MS)) {
    return acledAuthState.accessToken;
  }

  const creds = readAcledPasswordGrantCredentials();
  const clientId = (process.env.ACLED_CLIENT_ID || creds?.clientId || 'acled').trim() || 'acled';

  // Prefer refresh_token grant when available, then fall back to password grant.
  if (acledAuthState.refreshToken) {
    try {
      const refreshParams = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: acledAuthState.refreshToken,
        client_id: clientId,
      });
      const refreshed = await requestAcledToken(refreshParams);
      acledAuthState.accessToken = refreshed.accessToken;
      acledAuthState.refreshToken = refreshed.refreshToken ?? acledAuthState.refreshToken;
      acledAuthState.expiresAt = refreshed.expiresAt;
      process.env.ACLED_ACCESS_TOKEN = refreshed.accessToken;
      process.env.ACLED_REFRESH_TOKEN = acledAuthState.refreshToken ?? '';
      return refreshed.accessToken;
    } catch (error) {
      console.warn('[ACLED] refresh_token grant failed, falling back to password grant:', error);
    }
  }

  if (!creds) {
    return force ? null : acledAuthState.accessToken;
  }

  try {
    const passwordParams = new URLSearchParams({
      grant_type: 'password',
      username: creds.username,
      password: creds.password,
      client_id: creds.clientId,
    });
    const issued = await requestAcledToken(passwordParams);
    acledAuthState.accessToken = issued.accessToken;
    acledAuthState.refreshToken = issued.refreshToken;
    acledAuthState.expiresAt = issued.expiresAt;
    process.env.ACLED_ACCESS_TOKEN = issued.accessToken;
    process.env.ACLED_REFRESH_TOKEN = issued.refreshToken ?? '';
    return issued.accessToken;
  } catch (error) {
    console.warn('[ACLED] password grant failed:', error);
    return force ? null : acledAuthState.accessToken;
  }
}

async function getAcledAccessToken(force = false): Promise<string | null> {
  if (!force) {
    initializeAcledAuthStateFromEnv();
    if (acledAuthState.accessToken && Date.now() < (acledAuthState.expiresAt - ACLED_TOKEN_REFRESH_SKEW_MS)) {
      return acledAuthState.accessToken;
    }
  } else {
    // Force token renewal on explicit auth failure.
    acledAuthState.expiresAt = 0;
  }

  if (acledAuthState.refreshing) {
    return acledAuthState.refreshing;
  }

  acledAuthState.refreshing = refreshAcledToken(force)
    .finally(() => {
      acledAuthState.refreshing = null;
    });

  return acledAuthState.refreshing;
}

/**
 * Fetch ACLED events with automatic Redis caching.
 * Cache key is derived from query parameters so identical queries across
 * different handlers share the same cached result.
 */
export async function fetchAcledCached(opts: FetchAcledOptions): Promise<AcledRawEvent[]> {
  const token = await getAcledAccessToken();
  if (!token) return [];

  const cacheKey = `acled:shared:${opts.eventTypes}:${opts.startDate}:${opts.endDate}:${opts.country || 'all'}:${opts.limit || 500}`;
  const result = await cachedFetchJson<AcledRawEvent[]>(cacheKey, ACLED_CACHE_TTL, async () => {
    const params = new URLSearchParams({
      event_type: opts.eventTypes,
      event_date: `${opts.startDate}|${opts.endDate}`,
      event_date_where: 'BETWEEN',
      limit: String(opts.limit || 500),
      _format: 'json',
    });
    if (opts.country) params.set('country', opts.country);

    const fetchWithBearer = async (bearer: string): Promise<Response> => {
      return fetch(`${ACLED_API_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
          'User-Agent': CHROME_UA,
        },
        signal: AbortSignal.timeout(ACLED_TIMEOUT_MS),
      });
    };

    let resp = await fetchWithBearer(token);
    if (resp.status === 401) {
      const renewedToken = await getAcledAccessToken(true);
      if (!renewedToken) throw new Error('ACLED token expired and refresh failed');
      resp = await fetchWithBearer(renewedToken);
    }
    if (!resp.ok) throw new Error(`ACLED API error: ${resp.status}`);
    const data = (await resp.json()) as { data?: AcledRawEvent[]; message?: string; error?: string };
    if (data.message || data.error) throw new Error(data.message || data.error || 'ACLED API error');

    const events = data.data || [];
    return events.length > 0 ? events : null;
  });
  return result || [];
}
