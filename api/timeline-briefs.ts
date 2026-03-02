// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { cachedFetchJson } from '../server/_shared/redis';
import { CHROME_UA } from '../server/_shared/constants';

export const config = { runtime: 'edge' };

type Variant = 'full' | 'tech' | 'finance' | 'happy';
type BriefPeriod = '10m' | '1h' | '12h';

interface DigestItem {
  title?: string;
  publishedAt?: number;
}

interface DigestCategory {
  items?: DigestItem[];
}

interface DigestPayload {
  categories?: Record<string, DigestCategory>;
}

interface TimelineBrief {
  period: BriefPeriod;
  slotKey: string;
  startMs: number;
  endMs: number;
  generatedAt: number;
  summary: string;
  headlineCount: number;
  provider: string;
  model: string;
}

interface ProviderConfig {
  id: 'ollama' | 'openai' | 'groq' | 'openrouter';
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

const VALID_VARIANTS = new Set<Variant>(['full', 'tech', 'finance', 'happy']);
const SLOT_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 120;
const TEN_MIN_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HALF_DAY_MS = 12 * HOUR_MS;
const NY_TZ = 'America/New_York';

function normalizeVariant(value: string | null): Variant {
  if (value && VALID_VARIANTS.has(value as Variant)) return value as Variant;
  return 'full';
}

function getTenMinuteSlot(nowMs: number): { startMs: number; endMs: number; slotKey: string } {
  const endMs = Math.floor(nowMs / TEN_MIN_MS) * TEN_MIN_MS;
  const startMs = endMs - TEN_MIN_MS;
  return {
    startMs,
    endMs,
    slotKey: `u${Math.floor(endMs / TEN_MIN_MS)}`,
  };
}

function getHourlySlot(nowMs: number): { startMs: number; endMs: number; slotKey: string } {
  const endMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const startMs = endMs - HOUR_MS;
  return {
    startMs,
    endMs,
    slotKey: `u${Math.floor(endMs / HOUR_MS)}`,
  };
}

function getZonedParts(timestampMs: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));

  const out: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === 'literal') continue;
    out[part.type] = Number(part.value);
  }
  return out;
}

function getTimeZoneOffsetMs(timestampMs: number, timeZone: string): number {
  const parts = getZonedParts(timestampMs, timeZone);
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asUtc - timestampMs;
}

function zonedDateTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 2; i++) {
    const offset = getTimeZoneOffsetMs(utcGuess, timeZone);
    utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset;
  }
  return utcGuess;
}

function getNyHalfDaySlot(nowMs: number): { startMs: number; endMs: number; slotKey: string } {
  const parts = getZonedParts(nowMs, NY_TZ);
  let year = parts.year ?? 1970;
  let month = parts.month ?? 1;
  let day = parts.day ?? 1;
  const hour = parts.hour ?? 0;
  let anchorHour = 20;

  if (hour >= 20) {
    anchorHour = 20;
  } else if (hour >= 8) {
    anchorHour = 8;
  } else {
    anchorHour = 20;
    const prev = new Date(Date.UTC(year, month - 1, day) - 24 * HOUR_MS);
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }

  const endMs = zonedDateTimeToUtcMs(year, month, day, anchorHour, 0, NY_TZ);
  const startMs = endMs - HALF_DAY_MS;
  const slotKey = `ny-${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-${String(anchorHour).padStart(2, '0')}`;
  return { startMs, endMs, slotKey };
}

function getProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  if (process.env.OLLAMA_API_URL) {
    const baseUrl = process.env.OLLAMA_API_URL;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.OLLAMA_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
    }
    providers.push({
      id: 'ollama',
      apiUrl: new URL('/v1/chat/completions', baseUrl).toString(),
      model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      headers,
      extraBody: { think: false, max_tokens: 220 },
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      id: 'openai',
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  }

  if (process.env.GROQ_API_KEY) {
    providers.push({
      id: 'groq',
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  }

  if (process.env.OPENROUTER_API_KEY) {
    providers.push({
      id: 'openrouter',
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'WorldMonitor',
      },
    });
  }

  return providers;
}

async function fetchDigest(origin: string, variant: Variant): Promise<DigestPayload> {
  const url = `${origin}/api/news/v1/list-feed-digest?variant=${variant}&lang=en`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      Referer: `${origin}/`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Digest error: HTTP ${resp.status}`);
  return (await resp.json()) as DigestPayload;
}

function collectHeadlines(
  digest: DigestPayload,
  startMs: number,
  endMs: number,
): string[] {
  const rows: Array<{ title: string; ts: number }> = [];
  const categories = digest.categories ?? {};
  for (const bucket of Object.values(categories)) {
    const items = bucket?.items ?? [];
    for (const item of items) {
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      const ts = typeof item?.publishedAt === 'number' ? item.publishedAt : NaN;
      if (!title || !Number.isFinite(ts)) continue;
      if (ts <= startMs || ts > endMs) continue;
      rows.push({ title, ts });
    }
  }

  rows.sort((a, b) => b.ts - a.ts);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row.title);
    if (deduped.length >= 14) break;
  }
  return deduped;
}

function buildPrompts(headlines: string[], period: BriefPeriod, startMs: number, endMs: number): { system: string; user: string } {
  const periodLabel = period === '10m' ? '10-minute' : period === '1h' ? '1-hour' : '12-hour';
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const lines = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const system = `You are an intelligence editor for a global monitoring dashboard.
Write one concise factual brief (max 80 words) for the ${periodLabel} window.
Rules:
- Synthesize ONLY from the provided headlines.
- No speculation, no hype, no bullet points.
- Mention 2-3 most important developments only.
- Use plain neutral language.`;
  const user = `Window UTC: ${startIso} to ${endIso}

Headlines:
${lines}

Return one short paragraph.`;
  return { system, user };
}

async function summarizeHeadlines(
  headlines: string[],
  period: BriefPeriod,
  startMs: number,
  endMs: number,
): Promise<{ summary: string; provider: string; model: string }> {
  const providers = getProviders();
  if (providers.length === 0) {
    throw new Error('No AI provider configured');
  }
  const prompts = buildPrompts(headlines, period, startMs, endMs);

  let lastError = 'Unknown AI error';
  for (const provider of providers) {
    try {
      const resp = await fetch(provider.apiUrl, {
        method: 'POST',
        headers: { ...provider.headers, 'User-Agent': CHROME_UA },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: prompts.system },
            { role: 'user', content: prompts.user },
          ],
          temperature: 0.2,
          max_tokens: 180,
          top_p: 0.9,
          ...(provider.extraBody || {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        lastError = `${provider.id} HTTP ${resp.status}`;
        continue;
      }

      const data = await resp.json() as any;
      const content = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!content || content.length < 20) {
        lastError = `${provider.id} empty response`;
        continue;
      }
      return {
        summary: content,
        provider: provider.id,
        model: provider.model,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(lastError);
}

async function buildBriefForSlot(
  digestPromise: Promise<DigestPayload>,
  variant: Variant,
  period: BriefPeriod,
  startMs: number,
  endMs: number,
  slotKey: string,
): Promise<TimelineBrief> {
  const cacheKey = `timeline:briefs:v1:${variant}:${period}:${slotKey}`;

  const payload = await cachedFetchJson<TimelineBrief>(
    cacheKey,
    SLOT_CACHE_TTL_SECONDS,
    async () => {
      const digest = await digestPromise;
      const headlines = collectHeadlines(digest, startMs, endMs);
      if (headlines.length === 0) {
        return {
          period,
          slotKey,
          startMs,
          endMs,
          generatedAt: Date.now(),
          summary: 'No major developments in this window.',
          headlineCount: 0,
          provider: 'none',
          model: '',
        };
      }

      try {
        const summarized = await summarizeHeadlines(headlines, period, startMs, endMs);
        return {
          period,
          slotKey,
          startMs,
          endMs,
          generatedAt: Date.now(),
          summary: summarized.summary,
          headlineCount: headlines.length,
          provider: summarized.provider,
          model: summarized.model,
        };
      } catch (error) {
        const topHeadlines = headlines.slice(0, 3).join(' | ');
        return {
          period,
          slotKey,
          startMs,
          endMs,
          generatedAt: Date.now(),
          summary: topHeadlines || 'Summary unavailable for this window.',
          headlineCount: headlines.length,
          provider: 'fallback',
          model: '',
        };
      }
    },
    NEGATIVE_TTL_SECONDS,
  );

  if (payload) return payload;

  return {
    period,
    slotKey,
    startMs,
    endMs,
    generatedAt: Date.now(),
    summary: 'Summary unavailable for this window.',
    headlineCount: 0,
    provider: 'none',
    model: '',
  };
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const requestUrl = new URL(req.url);
    const variant = normalizeVariant(requestUrl.searchParams.get('variant'));
    const origin = requestUrl.origin;
    const nowMs = Date.now();

    const tenSlot = getTenMinuteSlot(nowMs);
    const hourSlot = getHourlySlot(nowMs);
    const nyHalfDaySlot = getNyHalfDaySlot(nowMs);

    const digestPromise = fetchDigest(origin, variant);
    const [brief10m, brief1h, brief12h] = await Promise.all([
      buildBriefForSlot(digestPromise, variant, '10m', tenSlot.startMs, tenSlot.endMs, tenSlot.slotKey),
      buildBriefForSlot(digestPromise, variant, '1h', hourSlot.startMs, hourSlot.endMs, hourSlot.slotKey),
      buildBriefForSlot(digestPromise, variant, '12h', nyHalfDaySlot.startMs, nyHalfDaySlot.endMs, nyHalfDaySlot.slotKey),
    ]);

    return new Response(JSON.stringify({
      generatedAt: Date.now(),
      variant,
      briefs: {
        tenMinutes: brief10m,
        oneHour: brief1h,
        twelveHours: brief12h,
      },
      schedule: {
        tenMinutes: 'every 10 minutes at :00/:10/:20/:30/:40/:50',
        oneHour: 'every hour at :00',
        twelveHours: '08:00 and 20:00 America/New_York',
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
        ...corsHeaders,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Timeline summary failed',
      details: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
