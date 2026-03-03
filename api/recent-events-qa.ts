// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { cachedFetchJson, cachedFetchJsonWithMeta, getCachedJson } from '../server/_shared/redis';
import { CHROME_UA } from '../server/_shared/constants';
import { logLocalLlmFailure, logLocalLlmRequest } from '../server/_shared/local-llm-log';
import { runWithLocalLlmQueue } from '../server/_shared/local-llm-queue';
import { extractFinalAnswerFromReasoning, extractLlmResponseText } from '../server/_shared/llm-content';
import { buildApiBaseOrigins } from './_internal-api-origin';

export const config = { runtime: 'edge' };

type Variant = 'full' | 'tech' | 'finance' | 'happy';

interface DigestItem {
  source?: string;
  title?: string;
  link?: string;
  publishedAt?: number;
}

interface DigestCategory {
  items?: DigestItem[];
}

interface DigestPayload {
  categories?: Record<string, DigestCategory>;
}

interface RecentHeadline {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

interface ContextBuildResult {
  lines: string[];
  headlineCount: number;
  contextChars: number;
  windowStartMs: number;
  windowEndMs: number;
}

interface ProviderConfig {
  id: 'ollama' | 'openai' | 'groq' | 'openrouter';
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

interface QAPayload {
  question: string;
  answer: string;
  provider: string;
  model: string;
  generatedAt: number;
  cached: boolean;
  headlineCount: number;
  contextChars: number;
  windowStartMs: number;
  windowEndMs: number;
}

interface UpstashPipelineResult {
  result?: string | number | null;
}

const VALID_VARIANTS = new Set<Variant>(['full', 'tech', 'finance', 'happy']);
const RECENT_WINDOW_MS = 36 * 60 * 60 * 1000;
const CONTEXT_CACHE_TTL_SECONDS = 120;
const ANSWER_CACHE_TTL_SECONDS = 5 * 60;
const NEGATIVE_TTL_SECONDS = 60;
const MAX_QUESTION_CHARS = 240;
const MIN_QUESTION_CHARS = 3;
const MAX_CONTEXT_HEADLINES = 50;
const MAX_CONTEXT_CHARS = 6000;
const DIGEST_CACHE_VERSION = 'v2';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
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

const GLOBAL_LIMIT = readPositiveInt('RECENT_QA_GLOBAL_LIMIT', 180);
const GLOBAL_WINDOW_SECONDS = readPositiveInt('RECENT_QA_GLOBAL_WINDOW_SECONDS', 600);
const VISITOR_LIMIT = readPositiveInt('RECENT_QA_VISITOR_LIMIT', 8);
const VISITOR_WINDOW_SECONDS = readPositiveInt('RECENT_QA_VISITOR_WINDOW_SECONDS', 600);

function getProviderTimeoutMs(provider: ProviderConfig['id'], contextChars = 0): number {
  if (provider === 'ollama') {
    const base = readPositiveInt('OLLAMA_TIMEOUT_MS', 120_000);
    const dynamicExtra = Math.min(90_000, Math.max(0, Math.floor(contextChars * 8)));
    return Math.min(readPositiveInt('RECENT_QA_OLLAMA_TIMEOUT_MAX_MS', 300_000), base + dynamicExtra);
  }
  return readPositiveInt('LLM_UPSTREAM_TIMEOUT_MS', 30_000);
}

function getCompletionLimit(provider: ProviderConfig['id'], model: string): number {
  if (provider === 'ollama') {
    return readPositiveInt('RECENT_QA_OLLAMA_FORCE_MAX_TOKENS',
      readPositiveInt('OLLAMA_FORCE_MAX_TOKENS', 0));
  }
  if (usesMaxCompletionTokens(provider, model)) {
    return readPositiveInt('RECENT_QA_OPENAI_MAX_COMPLETION_TOKENS', 260);
  }
  return readPositiveInt('RECENT_QA_MAX_TOKENS', 260);
}

function getRecentQaDigestFetchTimeoutMs(): number {
  return readPositiveInt('RECENT_QA_DIGEST_FETCH_TIMEOUT_MS', 35_000);
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

function hasMinimumChinese(text: string, minCount: number): boolean {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk >= minCount;
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

function getOllamaNoThinkPrefix(): string {
  return '/set nothink\n';
}

function buildOllamaChatMessages(systemPrompt: string, userPrompt: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: getOllamaNoThinkPrefix().trim() },
    { role: 'user', content: userPrompt },
  ];
}

function normalizeQuestion(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text.trim().slice(0, MAX_QUESTION_CHARS);
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-real-ip')
    || req.headers.get('cf-connecting-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '0.0.0.0'
  );
}

function getRedisPrefix(): string {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

function hashText(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
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
      model: process.env.OPENROUTER_MODEL || 'openrouter/auto',
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
  const timeoutMs = getRecentQaDigestFetchTimeoutMs();

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

function collectRecentHeadlines(digest: DigestPayload, nowMs: number): RecentHeadline[] {
  const categories = digest.categories ?? {};
  const minTs = nowMs - RECENT_WINDOW_MS;
  const maxTs = nowMs + 10 * 60 * 1000;
  const byTitle = new Map<string, RecentHeadline>();

  for (const bucket of Object.values(categories)) {
    const items = bucket?.items ?? [];
    for (const item of items) {
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      const source = typeof item?.source === 'string' ? item.source.trim() : 'unknown';
      const link = typeof item?.link === 'string' ? item.link : '';
      const publishedAt = typeof item?.publishedAt === 'number' ? item.publishedAt : NaN;
      if (!title || !Number.isFinite(publishedAt)) continue;
      if (publishedAt < minTs || publishedAt > maxTs) continue;

      const key = title.toLowerCase();
      const prev = byTitle.get(key);
      if (!prev || prev.publishedAt < publishedAt) {
        byTitle.set(key, { source, title, link, publishedAt });
      }
    }
  }

  return [...byTitle.values()]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 220);
}

function tokenizeQuestion(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/g)
    .filter((token) => token.length >= 2)
    .slice(0, 20);
}

function buildContext(question: string, headlines: RecentHeadline[]): ContextBuildResult {
  const now = Date.now();
  const tokens = tokenizeQuestion(question);

  const scored = headlines.map((headline) => {
    const hay = `${headline.title} ${headline.source}`.toLowerCase();
    let overlap = 0;
    for (const token of tokens) {
      if (hay.includes(token)) overlap += 1;
    }
    const ageRatio = Math.max(0, Math.min(1, (now - headline.publishedAt) / RECENT_WINDOW_MS));
    const recencyScore = 1 - ageRatio;
    const score = overlap * 10 + recencyScore;
    return { headline, score };
  });

  scored.sort((a, b) => (b.score - a.score) || (b.headline.publishedAt - a.headline.publishedAt));

  const lines: string[] = [];
  let contextChars = 0;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;

  for (const entry of scored) {
    if (lines.length >= MAX_CONTEXT_HEADLINES) break;
    const idx = lines.length + 1;
    const iso = new Date(entry.headline.publishedAt).toISOString();
    const line = `${idx}. [${iso}] (${entry.headline.source}) ${entry.headline.title}`;
    if (contextChars + line.length > MAX_CONTEXT_CHARS) break;
    lines.push(line);
    contextChars += line.length;
    if (entry.headline.publishedAt < firstTs) firstTs = entry.headline.publishedAt;
    if (entry.headline.publishedAt > lastTs) lastTs = entry.headline.publishedAt;
  }

  if (lines.length === 0 && headlines.length > 0) {
    for (const item of headlines.slice(0, 10)) {
      const idx = lines.length + 1;
      const iso = new Date(item.publishedAt).toISOString();
      const line = `${idx}. [${iso}] (${item.source}) ${item.title}`;
      if (contextChars + line.length > MAX_CONTEXT_CHARS) break;
      lines.push(line);
      contextChars += line.length;
      if (item.publishedAt < firstTs) firstTs = item.publishedAt;
      if (item.publishedAt > lastTs) lastTs = item.publishedAt;
    }
  }

  return {
    lines,
    headlineCount: lines.length,
    contextChars,
    windowStartMs: Number.isFinite(firstTs) ? firstTs : now - RECENT_WINDOW_MS,
    windowEndMs: lastTs || now,
  };
}

function buildPrompts(
  question: string,
  context: ContextBuildResult,
  outputLang: string,
): { system: string; user: string } {
  const languageRule = isChineseLanguage(outputLang)
    ? '- Always answer in Simplified Chinese (简体中文, zh-CN).\n- Never use Traditional Chinese characters.'
    : outputLang.toLowerCase().startsWith('en')
      ? '- Always answer in English.'
      : `- Always answer in ${outputLang}.`;
  const system = `You answer user questions about recent events using ONLY the provided headlines.
Rules:
- Do not invent facts.
- If evidence is insufficient, explicitly say so.
- Keep answer under 120 words.
- Use plain text only (no markdown table, no code block).
- Output only the final answer. Do not output thinking steps, reasoning process, or prompt analysis.
${languageRule}`;
  const user = `Question:
${question}

Recent headlines:
${context.lines.join('\n')}
`;
  return { system, user };
}

async function askWithProviders(
  question: string,
  context: ContextBuildResult,
  outputLang: string,
): Promise<{ answer: string; provider: string; model: string }> {
  const providers = getProviders();
  if (providers.length === 0) {
    throw new Error('No AI provider configured');
  }

  const prompts = buildPrompts(question, context, outputLang);
  let lastError = 'Unknown AI error';

  for (const provider of providers) {
    try {
      const invokeProvider = async (): Promise<{ answer: string; provider: string; model: string }> => {
        const completionLimit = getCompletionLimit(provider.id, provider.model);
        const buildBody = () => {
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

        const call = async (
          body: Record<string, unknown>,
          scope: 'recent-events-qa' | 'recent-events-qa-retry',
        ): Promise<Record<string, unknown>> => {
          logLocalLlmRequest(scope, provider.id, provider.apiUrl, provider.model);
          const resp = await fetch(provider.apiUrl, {
            method: 'POST',
            headers: { ...provider.headers, 'User-Agent': CHROME_UA },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(getProviderTimeoutMs(provider.id, context.contextChars)),
          });

          if (!resp.ok) {
            const errorText = (await resp.text()).replace(/\s+/g, ' ').trim().slice(0, 240);
            throw new Error(`${provider.id} HTTP ${resp.status}${errorText ? `: ${errorText}` : ''}`);
          }

          return await resp.json() as Record<string, unknown>;
        };

        let data = await call(buildBody(), 'recent-events-qa');
        let answer = extractLlmResponseText(data).trim();
        if (!answer) {
          answer = extractFinalAnswerFromReasoning(data).trim();
        }
        if (!answer && provider.id === 'ollama') {
          data = await call(buildBody(), 'recent-events-qa-retry');
          answer = extractLlmResponseText(data).trim();
          if (!answer) {
            answer = extractFinalAnswerFromReasoning(data).trim();
          }
        }
        if (!answer) {
          logLocalLlmFailure('recent-events-qa', provider.id, provider.model, 'empty_response', data, {
            questionLen: question.length,
            headlineCount: context.headlineCount,
            contextChars: context.contextChars,
          });
          throw new Error(`${provider.id} empty response`);
        }
        if (isChineseLanguage(outputLang) && !hasMinimumChinese(answer, 2)) {
          logLocalLlmFailure('recent-events-qa', provider.id, provider.model, 'non_chinese_output', data, {
            questionLen: question.length,
            headlineCount: context.headlineCount,
            contextChars: context.contextChars,
            answerLen: answer.length,
            lang: outputLang,
          });
          throw new Error(`${provider.id} non-Chinese response`);
        }
        return { answer, provider: provider.id, model: provider.model };
      };

      if (provider.id === 'ollama') {
        return await runWithLocalLlmQueue('recent-events-qa', invokeProvider);
      }
      return await invokeProvider();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLocalLlmFailure('recent-events-qa', provider.id, provider.model, 'request_error', undefined, {
        error: message.slice(0, 180),
      });
      lastError = message;
    }
  }

  throw new Error(lastError);
}

async function hitWindowRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetInSeconds: number; limit: number }> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || limit <= 0 || windowSeconds <= 0) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetInSeconds: 0, limit };
  }

  try {
    const pipeline = [
      ['INCR', key],
      ['EXPIRE', key, String(windowSeconds), 'NX'],
      ['TTL', key],
    ];

    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(3_000),
    });

    if (!resp.ok) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetInSeconds: 0, limit };
    }

    const rows = (await resp.json()) as UpstashPipelineResult[];
    const count = Number(rows[0]?.result ?? 0);
    const ttl = Number(rows[2]?.result ?? windowSeconds);
    const resetInSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : windowSeconds;
    const remaining = Math.max(0, limit - count);

    return {
      allowed: count <= limit,
      remaining,
      resetInSeconds,
      limit,
    };
  } catch {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetInSeconds: 0, limit };
  }
}

async function enforceQaRateLimits(req: Request, variant: Variant): Promise<Response | null> {
  const prefix = getRedisPrefix();
  const visitor = getClientIp(req);

  const [visitorResult, globalResult] = await Promise.all([
    hitWindowRateLimit(`${prefix}rl:recent-qa:visitor:${visitor}`, VISITOR_LIMIT, VISITOR_WINDOW_SECONDS),
    hitWindowRateLimit(`${prefix}rl:recent-qa:global:${variant}`, GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS),
  ]);

  if (!visitorResult.allowed) {
    return new Response(JSON.stringify({
      error: 'Too many questions from this visitor',
      reason: 'visitor_rate_limited',
      retryAfterSec: visitorResult.resetInSeconds,
      limit: visitorResult.limit,
      remaining: visitorResult.remaining,
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(visitorResult.resetInSeconds),
      },
    });
  }

  if (!globalResult.allowed) {
    return new Response(JSON.stringify({
      error: 'Service is busy, try again shortly',
      reason: 'global_rate_limited',
      retryAfterSec: globalResult.resetInSeconds,
      limit: globalResult.limit,
      remaining: globalResult.remaining,
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(globalResult.resetInSeconds),
      },
    });
  }

  return null;
}

async function getRecentHeadlineCache(origins: string[], variant: Variant): Promise<RecentHeadline[]> {
  const key = `recent-events-qa:headlines:v1:${variant}`;
  const cached = await cachedFetchJson<RecentHeadline[]>(
    key,
    CONTEXT_CACHE_TTL_SECONDS,
    async () => {
      const digest = await fetchDigest(origins, variant);
      return collectRecentHeadlines(digest, Date.now());
    },
    NEGATIVE_TTL_SECONDS,
  );
  return cached ?? [];
}

function getNoRecentCacheMessage(outputLang: string): string {
  if (isChineseLanguage(outputLang)) {
    return '当前暂无可用的近期事件缓存，请几分钟后再试。';
  }
  return 'No recent-event cache is available yet. Please try again in a few minutes.';
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'POST, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
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

  const baseRateLimit = await checkRateLimit(req, corsHeaders);
  if (baseRateLimit) return baseRateLimit;

  try {
    const requestUrl = new URL(req.url);
    const body = await req.json().catch(() => ({})) as { question?: unknown; variant?: string; lang?: string };
    const question = normalizeQuestion(body?.question);
    if (question.length < MIN_QUESTION_CHARS) {
      return new Response(JSON.stringify({
        error: `Question must be at least ${MIN_QUESTION_CHARS} characters`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const variant = normalizeVariant(
      requestUrl.searchParams.get('variant')
      || (typeof body?.variant === 'string' ? body.variant : null),
    );
    const outputLang = normalizeOutputLanguage(
      requestUrl.searchParams.get('lang')
      || (typeof body?.lang === 'string' ? body.lang : null)
      || req.headers.get('x-user-lang')
      || req.headers.get('accept-language'),
    );

    const customRateLimit = await enforceQaRateLimits(req, variant);
    if (customRateLimit) {
      const payload = await customRateLimit.json().catch(() => ({}));
      return new Response(JSON.stringify(payload), {
        status: customRateLimit.status,
        headers: { ...Object.fromEntries(customRateLimit.headers.entries()), ...corsHeaders },
      });
    }

    const origins = buildApiBaseOrigins(req);
    const now = Date.now();
    const slot = Math.floor(now / (5 * 60 * 1000));
    const qHash = hashText(question.toLowerCase());
    const cacheLang = toLanguageCacheKey(outputLang);
    const cacheKey = `recent-events-qa:answer:v1:${variant}:${cacheLang}:${slot}:${qHash}`;

    const { data: payload, source } = await cachedFetchJsonWithMeta<QAPayload>(
      cacheKey,
      ANSWER_CACHE_TTL_SECONDS,
      async () => {
        const headlines = await getRecentHeadlineCache(origins, variant);
        if (headlines.length === 0) {
          return {
            question,
            answer: getNoRecentCacheMessage(outputLang),
            provider: 'none',
            model: '',
            generatedAt: Date.now(),
            cached: false,
            headlineCount: 0,
            contextChars: 0,
            windowStartMs: now - RECENT_WINDOW_MS,
            windowEndMs: now,
          };
        }

        const context = buildContext(question, headlines);
        const result = await askWithProviders(question, context, outputLang);
        return {
          question,
          answer: result.answer,
          provider: result.provider,
          model: result.model,
          generatedAt: Date.now(),
          cached: false,
          headlineCount: context.headlineCount,
          contextChars: context.contextChars,
          windowStartMs: context.windowStartMs,
          windowEndMs: context.windowEndMs,
        };
      },
      NEGATIVE_TTL_SECONDS,
    );

    if (!payload) {
      return new Response(JSON.stringify({
        error: 'Recent events QA unavailable',
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const response = { ...payload, cached: source === 'cache' };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=0, no-store',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('No AI provider configured') ? 503 : 500;
    return new Response(JSON.stringify({
      error: status === 503 ? 'No AI provider configured' : 'Recent events QA failed',
      details: message,
    }), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
