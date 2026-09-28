// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { cachedFetchJson, getCachedJson, setCachedJson } from '../server/_shared/redis';
import { CHROME_UA } from '../server/_shared/constants';
import {
  logLlmRawFetchError,
  logLlmRawRequest,
  logLlmRawResponse,
  logLocalLlmFailure,
  logLocalLlmRequest,
} from '../server/_shared/local-llm-log';
import { runWithLocalLlmQueue } from '../server/_shared/local-llm-queue';
import { extractFinalAnswerFromReasoning, extractLlmResponseText, isLlmLengthFinish } from '../server/_shared/llm-content';
import { buildApiBaseOrigins } from './_internal-api-origin';

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
const TIMELINE_BRIEF_CACHE_VERSION = 'v2';
const DIGEST_CACHE_VERSION = 'v2';
const SLOT_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;
const NEGATIVE_TTL_SECONDS = 120;
const TEN_MIN_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HALF_DAY_MS = 12 * HOUR_MS;
const NY_TZ = 'America/New_York';
const TIMELINE_PROCESS_STARTED_AT = Date.now();

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function envEnabled(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const OPENAI_PROVIDER_DISABLED = envEnabled('LLM_DISABLE_OPENAI')
  || envEnabled('DISABLE_OPENAI')
  || envEnabled('OPENAI_DISABLED');

function getTimelineStartupGraceMs(): number {
  return parsePositiveInt(process.env.TIMELINE_STARTUP_GRACE_MS) ?? 8 * 60 * 1000;
}

function isTimelineStartupGracePeriod(): boolean {
  return (Date.now() - TIMELINE_PROCESS_STARTED_AT) < getTimelineStartupGraceMs();
}

function getProviderTimeoutMs(provider: ProviderConfig['id'], period: BriefPeriod): number {
  const inStartupGrace = isTimelineStartupGracePeriod();
  if (provider === 'ollama') {
    const defaultByPeriod = period === '12h' ? 75_000 : period === '1h' ? 60_000 : 45_000;
    const base = parsePositiveInt(process.env.TIMELINE_OLLAMA_TIMEOUT_MS)
      ?? parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS)
      ?? defaultByPeriod;
    if (!inStartupGrace) return base;
    return parsePositiveInt(process.env.TIMELINE_STARTUP_OLLAMA_TIMEOUT_MS)
      ?? Math.max(base, defaultByPeriod + 30_000);
  }
  const base = parsePositiveInt(process.env.TIMELINE_LLM_UPSTREAM_TIMEOUT_MS)
    ?? parsePositiveInt(process.env.LLM_UPSTREAM_TIMEOUT_MS)
    ?? 12_000;
  if (!inStartupGrace) return base;
  return parsePositiveInt(process.env.TIMELINE_STARTUP_LLM_UPSTREAM_TIMEOUT_MS)
    ?? Math.max(base, 20_000);
}

function getTimelineTotalTimeoutMs(period: BriefPeriod): number {
  const defaultByPeriod = period === '12h' ? 180_000 : period === '1h' ? 120_000 : 90_000;
  const base = parsePositiveInt(process.env.TIMELINE_LLM_TOTAL_TIMEOUT_MS) ?? defaultByPeriod;
  if (!isTimelineStartupGracePeriod()) return base;
  return parsePositiveInt(process.env.TIMELINE_STARTUP_TOTAL_TIMEOUT_MS)
    ?? Math.max(base, defaultByPeriod + 60_000);
}

function getTimelineDigestFetchTimeoutMs(): number {
  const base = parsePositiveInt(process.env.TIMELINE_DIGEST_FETCH_TIMEOUT_MS) ?? 20_000;
  if (!isTimelineStartupGracePeriod()) return base;
  return parsePositiveInt(process.env.TIMELINE_STARTUP_DIGEST_FETCH_TIMEOUT_MS)
    ?? Math.max(base, 50_000);
}

function getTimelineCompletionLimit(provider: ProviderConfig['id'], model: string): number {
  if (provider === 'ollama') {
    return parsePositiveInt(process.env.TIMELINE_OLLAMA_FORCE_MAX_TOKENS)
      ?? parsePositiveInt(process.env.OLLAMA_FORCE_MAX_TOKENS)
      ?? 0;
  }
  if (usesMaxCompletionTokens(provider, model)) {
    return parsePositiveInt(process.env.TIMELINE_OPENAI_MAX_COMPLETION_TOKENS) ?? 420;
  }
  return parsePositiveInt(process.env.TIMELINE_MAX_TOKENS) ?? 180;
}

function getTimelineOllamaProviderAttempts(): number {
  return parsePositiveInt(process.env.TIMELINE_OLLAMA_PROVIDER_ATTEMPTS)
    ?? parsePositiveInt(process.env.OLLAMA_PROVIDER_ATTEMPTS)
    ?? 2;
}

function getTimelineOllamaRetryDelayMs(): number {
  return parsePositiveInt(process.env.TIMELINE_OLLAMA_PROVIDER_RETRY_DELAY_MS) ?? 1200;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function usesMaxCompletionTokens(provider: ProviderConfig['id'], model: string): boolean {
  if (provider !== 'openai') return false;
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
  );
}

function usesDefaultSamplingOnly(provider: ProviderConfig['id'], model: string): boolean {
  if (provider !== 'openai') return false;
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
  );
}

function normalizeVariant(value: string | null): Variant {
  if (value && VALID_VARIANTS.has(value as Variant)) return value as Variant;
  return 'full';
}

function extractPrimaryLanguage(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.split(',')[0]?.split(';')[0]?.trim() || '';
}

function normalizeOutputLanguage(raw: string | null | undefined): string {
  const primary = extractPrimaryLanguage(raw);
  if (!primary) return 'en';
  const lowered = primary.toLowerCase();
  if (lowered === 'zh' || lowered.startsWith('zh-')) return 'zh-CN';
  return primary;
}

function isChineseLanguage(lang: string): boolean {
  const lowered = (lang || '').toLowerCase();
  return lowered === 'zh' || lowered.startsWith('zh-');
}

function toLanguageCacheKey(lang: string): string {
  return (lang || 'en').toLowerCase().replace(/[^a-z0-9-]+/g, '_');
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
      extraBody: { think: false },
    });
  }

  if (process.env.OPENAI_API_KEY && !OPENAI_PROVIDER_DISABLED) {
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

async function fetchDigest(origins: string[], variant: Variant): Promise<DigestPayload> {
  const cached = await getCachedJson(`news:digest:${DIGEST_CACHE_VERSION}:${variant}:en`);
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
    return cached as DigestPayload;
  }

  const attempts: string[] = [];
  const dedupedOrigins = [...new Set(origins.filter(Boolean))];
  const timeoutMs = getTimelineDigestFetchTimeoutMs();

  const requests = dedupedOrigins.map(async (origin) => {
    const url = `${origin}/api/news/v1/list-feed-digest?variant=${variant}&lang=en`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': CHROME_UA,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return (await resp.json()) as DigestPayload;
    } catch (error) {
      attempts.push(`${origin}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });

  if (requests.length === 0) {
    throw new Error('Digest fetch failed (no candidate origins)');
  }

  try {
    const fastest = await new Promise<DigestPayload>((resolve, reject) => {
      let failures = 0;
      for (const req of requests) {
        req.then(resolve).catch(() => {
          failures += 1;
          if (failures >= requests.length) {
            reject(new Error('all digest origins failed'));
          }
        });
      }
    });
    return fastest;
  } catch {
    const fallback = await getCachedJson(`news:digest:${DIGEST_CACHE_VERSION}:${variant}:en`);
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      return fallback as DigestPayload;
    }
    throw new Error(`Digest fetch failed (${attempts.join(' | ')})`);
  }
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

function buildPrompts(
  headlines: string[],
  period: BriefPeriod,
  startMs: number,
  endMs: number,
  outputLang: string,
): { system: string; user: string } {
  const periodLabel = period === '10m' ? '10-minute' : period === '1h' ? '1-hour' : '12-hour';
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const lines = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const languageRule = isChineseLanguage(outputLang)
    ? '- Output MUST be in Simplified Chinese (简体中文, zh-CN).\n- Never use Traditional Chinese characters.'
    : outputLang.toLowerCase().startsWith('en')
      ? '- Output MUST be in English.'
      : `- Output MUST be in ${outputLang}.`;
  const system = `You are an intelligence editor for a global monitoring dashboard.
Write one concise factual brief (max 80 words) for the ${periodLabel} window.
Rules:
- Synthesize ONLY from the provided headlines.
- No speculation, no hype, no bullet points.
- Mention 2-3 most important developments only.
- Use plain neutral language.
- Output only the final summary paragraph. Do not output thinking steps, reasoning process, or prompt analysis.
${languageRule}`;
  const user = `Window UTC: ${startIso} to ${endIso}

Headlines:
${lines}

Return one short paragraph.`;
  return { system, user };
}

function isLikelyChinese(text: string): boolean {
  if (!text) return false;
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk >= 12;
}

function hasThinkingScaffold(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /(thinking process|analyze the request|current date|constraints|^\s*\*\*task\*\*)/im.test(t);
}

function hasMinimumChinese(text: string, minCount: number): boolean {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk >= minCount;
}

function stripReasoningBlocks(raw: string): string {
  if (!raw) return '';
  const original = raw;
  let out = raw;
  out = out
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .trim();

  out = out
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\|thinking\|>[\s\S]*/gi, '')
    .replace(/<reasoning>[\s\S]*/gi, '')
    .replace(/<reflection>[\s\S]*/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
    .trim();

  // If strict block stripping removed everything, keep text and only strip markers.
  if (!out) {
    const markerStripped = original
      .replace(/<\/?think>/gi, '')
      .replace(/<\|thinking\|>/gi, '')
      .replace(/<\|\/thinking\|>/gi, '')
      .replace(/<\/?reasoning>/gi, '')
      .replace(/<\/?reflection>/gi, '')
      .replace(/<\|begin_of_thought\|>/gi, '')
      .replace(/<\|end_of_thought\|>/gi, '')
      .trim();
    if (markerStripped) return markerStripped;
  }

  return out;
}

function buildOllamaChatMessages(systemPrompt: string, userPrompt: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function getPeriodLabel(period: BriefPeriod, outputLang: string): string {
  if (isChineseLanguage(outputLang)) {
    if (period === '10m') return '10分钟';
    if (period === '1h') return '1小时';
    return '12小时';
  }
  if (period === '10m') return '10-minute';
  if (period === '1h') return '1-hour';
  return '12-hour';
}

function getPendingSummaryText(period: BriefPeriod, outputLang: string): string {
  const label = getPeriodLabel(period, outputLang);
  if (isChineseLanguage(outputLang)) {
    return `该${label}窗口摘要正在排队生成，请稍后刷新。`;
  }
  return `The ${label} window summary is queued. Please refresh shortly.`;
}

function getNoUpdatesText(outputLang: string): string {
  if (isChineseLanguage(outputLang)) {
    return '该时间窗口内暂无重大进展。';
  }
  return 'No major developments in this time window.';
}

function getUnavailableSummaryText(period: BriefPeriod, outputLang: string): string {
  const label = getPeriodLabel(period, outputLang);
  if (isChineseLanguage(outputLang)) {
    return `该${label}窗口摘要暂不可用，请稍后重试。`;
  }
  return `The ${label} window summary is temporarily unavailable. Please retry later.`;
}

function getUnavailableShortText(outputLang: string): string {
  if (isChineseLanguage(outputLang)) {
    return '该时间窗口摘要暂不可用。';
  }
  return 'Summary unavailable for this time window.';
}

async function summarizeHeadlines(
  headlines: string[],
  period: BriefPeriod,
  startMs: number,
  endMs: number,
  outputLang: string,
): Promise<{ summary: string; provider: string; model: string }> {
  const providers = getProviders();
  if (providers.length === 0) {
    throw new Error('No AI provider configured');
  }
  const prompts = buildPrompts(headlines, period, startMs, endMs, outputLang);
  let deadline = 0;

  let lastError = 'Unknown AI error';
  for (const provider of providers) {
    const invokeProvider = async (): Promise<{ summary: string; provider: string; model: string }> => {
        const buildBody = (completionLimit: number) => {
          return {
            model: provider.model,
            messages: provider.id === 'ollama'
              ? buildOllamaChatMessages(prompts.system, prompts.user)
              : [
                { role: 'system', content: prompts.system },
                { role: 'user', content: prompts.user },
              ],
            ...(usesDefaultSamplingOnly(provider.id, provider.model) ? {} : { temperature: 0.2, top_p: 0.9 }),
            ...(completionLimit > 0
              ? (usesMaxCompletionTokens(provider.id, provider.model)
                ? { max_completion_tokens: completionLimit }
                : { max_tokens: completionLimit })
              : {}),
            ...(provider.extraBody || {}),
          };
        };

        const callProvider = async (
          requestBody: Record<string, unknown>,
          logScope: 'timeline-briefs' | 'timeline-briefs-retry',
        ): Promise<any> => {
          if (deadline <= 0) {
            deadline = Date.now() + getTimelineTotalTimeoutMs(period);
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 800) {
            throw new Error('timeline llm budget exceeded');
          }

          logLocalLlmRequest(logScope, provider.id, provider.apiUrl, provider.model);
          logLlmRawRequest(logScope, provider.id, provider.apiUrl, provider.model, requestBody);
          let resp: Response;
          try {
            resp = await fetch(provider.apiUrl, {
              method: 'POST',
              headers: { ...provider.headers, 'User-Agent': CHROME_UA },
              body: JSON.stringify(requestBody),
              signal: AbortSignal.timeout(Math.min(getProviderTimeoutMs(provider.id, period), remainingMs)),
            });
          } catch (error) {
            logLlmRawFetchError(logScope, provider.id, provider.apiUrl, provider.model, error);
            throw error;
          }
          const rawBody = await resp.text();
          logLlmRawResponse(logScope, provider.id, provider.apiUrl, provider.model, resp.status, rawBody);

          if (!resp.ok) {
            throw new Error(`${provider.id} HTTP ${resp.status}`);
          }
          try {
            return JSON.parse(rawBody) as any;
          } catch {
            throw new Error(`${provider.id} invalid JSON response`);
          }
        };

        const completionLimit = getTimelineCompletionLimit(provider.id, provider.model);
        const isOpenAiReasoningModel = usesMaxCompletionTokens(provider.id, provider.model);

        let data = await callProvider(buildBody(completionLimit), 'timeline-briefs');
        let content = extractLlmResponseText(data).trim();
        if (!content && provider.id === 'ollama') {
          content = extractFinalAnswerFromReasoning(data).trim();
        }
        if (provider.id === 'ollama') {
          content = stripReasoningBlocks(content);
        }

        if ((!content || content.length < 2) && provider.id === 'ollama') {
          data = await callProvider(buildBody(completionLimit), 'timeline-briefs-retry');
          content = extractLlmResponseText(data).trim();
          if (!content) {
            content = extractFinalAnswerFromReasoning(data).trim();
          }
          content = stripReasoningBlocks(content);
        }

        if ((!content || content.length < 20) && isOpenAiReasoningModel && isLlmLengthFinish(data)) {
          const firstRetryLimit = Math.min(
            1800,
            Math.max(completionLimit + 400, Math.floor(completionLimit * 3)),
          );
          data = await callProvider(buildBody(firstRetryLimit), 'timeline-briefs-retry');
          content = extractLlmResponseText(data).trim();
          if (!content && provider.id === 'ollama') {
            content = extractFinalAnswerFromReasoning(data).trim();
          }
          if (provider.id === 'ollama') {
            content = stripReasoningBlocks(content);
          }
        }

        if ((!content || content.length < 20) && isOpenAiReasoningModel && isLlmLengthFinish(data)) {
          const secondRetryLimit = Math.min(
            3000,
            Math.max(completionLimit + 1200, Math.floor(completionLimit * 5)),
          );
          data = await callProvider(buildBody(secondRetryLimit), 'timeline-briefs-retry');
          content = extractLlmResponseText(data).trim();
          if (!content && provider.id === 'ollama') {
            content = extractFinalAnswerFromReasoning(data).trim();
          }
          if (provider.id === 'ollama') {
            content = stripReasoningBlocks(content);
          }
        }

        const minAcceptedLength = provider.id === 'ollama' ? 2 : 20;
        if (!content || content.length < minAcceptedLength) {
          logLocalLlmFailure('timeline-briefs', provider.id, provider.model, 'empty_or_too_short', data, {
            contentLen: content.length,
            minAcceptedLength,
            period,
          });
          throw new Error(`${provider.id} empty response`);
        }
        if (provider.id === 'ollama' && hasThinkingScaffold(content)) {
          logLocalLlmFailure('timeline-briefs', provider.id, provider.model, 'reasoning_scaffold', data, {
            contentLen: content.length,
            period,
          });
          throw new Error(`${provider.id} reasoning scaffold response`);
        }
        if (isChineseLanguage(outputLang)) {
          if (provider.id === 'ollama' && !hasMinimumChinese(content, 2)) {
            logLocalLlmFailure('timeline-briefs', provider.id, provider.model, 'non_chinese_output', data, {
              contentLen: content.length,
              period,
              lang: outputLang,
            });
            throw new Error(`${provider.id} non-Chinese response`);
          }
          if (provider.id !== 'ollama' && !isLikelyChinese(content)) {
            logLocalLlmFailure('timeline-briefs', provider.id, provider.model, 'non_chinese_output', data, {
              contentLen: content.length,
              period,
              lang: outputLang,
            });
            throw new Error(`${provider.id} non-Chinese response`);
          }
        }
        return {
          summary: content,
          provider: provider.id,
          model: provider.model,
        };
      };
    const providerAttempts = provider.id === 'ollama' ? getTimelineOllamaProviderAttempts() : 1;
    for (let attempt = 1; attempt <= providerAttempts; attempt += 1) {
      try {
        if (provider.id === 'ollama') {
          return await runWithLocalLlmQueue('timeline-briefs', invokeProvider);
        }
        return await invokeProvider();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (provider.id !== 'ollama' || attempt >= providerAttempts) {
          break;
        }
        const remainingMs = deadline - Date.now();
        const retryDelayMs = Math.min(
          getTimelineOllamaRetryDelayMs() * attempt,
          Math.max(0, remainingMs - 1200),
        );
        if (retryDelayMs > 0) {
          await sleepMs(retryDelayMs);
        }
      }
    }
  }

  throw new Error(lastError);
}

async function buildBriefForSlot(
  digestPromise: Promise<DigestPayload>,
  variant: Variant,
  outputLang: string,
  period: BriefPeriod,
  startMs: number,
  endMs: number,
  slotKey: string,
  forceRefresh = false,
  cacheOnly = false,
): Promise<TimelineBrief> {
  const cacheLang = toLanguageCacheKey(outputLang);
  const cacheKey = `timeline:briefs:${TIMELINE_BRIEF_CACHE_VERSION}:${variant}:${cacheLang}:${period}:${slotKey}`;

  if (cacheOnly) {
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
      const brief = cached as Partial<TimelineBrief>;
      if (typeof brief.summary === 'string' && typeof brief.period === 'string') {
        return brief as TimelineBrief;
      }
    }
    return {
      period,
      slotKey,
      startMs,
      endMs,
      generatedAt: Date.now(),
      summary: getPendingSummaryText(period, outputLang),
      headlineCount: 0,
      provider: 'pending',
      model: '',
    };
  }

  const generateBrief = async (): Promise<TimelineBrief> => {
    const digest = await digestPromise;
    const headlines = collectHeadlines(digest, startMs, endMs);
    if (headlines.length === 0) {
      return {
        period,
        slotKey,
        startMs,
        endMs,
        generatedAt: Date.now(),
        summary: getNoUpdatesText(outputLang),
        headlineCount: 0,
        provider: 'none',
        model: '',
      };
    }

    try {
      const summarized = await summarizeHeadlines(headlines, period, startMs, endMs, outputLang);
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
      console.error(
        `[timeline-briefs] ${period} summary unavailable:`,
        error instanceof Error ? error.message : String(error),
      );
      return {
        period,
        slotKey,
        startMs,
        endMs,
        generatedAt: Date.now(),
        summary: getUnavailableSummaryText(period, outputLang),
        headlineCount: headlines.length,
        provider: 'fallback',
        model: '',
      };
    }
  };

  if (forceRefresh) {
    const forced = await generateBrief();
    await setCachedJson(cacheKey, forced, SLOT_CACHE_TTL_SECONDS);
    return forced;
  }

  const payload = await cachedFetchJson<TimelineBrief>(
    cacheKey,
    SLOT_CACHE_TTL_SECONDS,
    generateBrief,
    NEGATIVE_TTL_SECONDS,
  );

  if (payload) return payload;

  return {
    period,
    slotKey,
    startMs,
    endMs,
    generatedAt: Date.now(),
    summary: getUnavailableShortText(outputLang),
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
    const outputLang = normalizeOutputLanguage(
      requestUrl.searchParams.get('lang')
      || req.headers.get('x-user-lang')
      || req.headers.get('accept-language'),
    );
    const forceTenMinutes = requestUrl.searchParams.get('forceTenMinutes') === '1';
    const onlyTenMinutes = requestUrl.searchParams.get('only') === '10m';
    const refreshLongWindows = requestUrl.searchParams.get('refreshLong') === '1';
    const explicitLongWindowCacheMode = (
      requestUrl.searchParams.get('longWindows') === 'cache'
      || process.env.TIMELINE_CACHE_LONG_WINDOWS_ONLY === 'true'
    );
    const cacheLongWindowsOnly = (
      !refreshLongWindows
      && explicitLongWindowCacheMode
    );
    const origins = buildApiBaseOrigins(req);
    const nowMs = Date.now();

    const tenSlot = getTenMinuteSlot(nowMs);
    const hourSlot = getHourlySlot(nowMs);
    const nyHalfDaySlot = getNyHalfDaySlot(nowMs);

    const digestPromise = fetchDigest(origins, variant);
    const brief10m = await buildBriefForSlot(
      digestPromise,
      variant,
      outputLang,
      '10m',
      tenSlot.startMs,
      tenSlot.endMs,
      tenSlot.slotKey,
      forceTenMinutes,
    );

    const [brief1h, brief12h] = onlyTenMinutes
      ? [undefined, undefined]
      : await Promise.all([
        buildBriefForSlot(
          digestPromise,
          variant,
          outputLang,
          '1h',
          hourSlot.startMs,
          hourSlot.endMs,
          hourSlot.slotKey,
          false,
          cacheLongWindowsOnly,
        ),
        buildBriefForSlot(
          digestPromise,
          variant,
          outputLang,
          '12h',
          nyHalfDaySlot.startMs,
          nyHalfDaySlot.endMs,
          nyHalfDaySlot.slotKey,
          false,
          cacheLongWindowsOnly,
        ),
      ]);

    return new Response(JSON.stringify({
      generatedAt: Date.now(),
      variant,
      lang: outputLang,
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
        'Cache-Control': forceTenMinutes
          ? 'no-store'
          : 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error('[timeline-briefs] request failed:', error);
    return new Response(JSON.stringify({
      error: 'Timeline summary failed',
      details: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
