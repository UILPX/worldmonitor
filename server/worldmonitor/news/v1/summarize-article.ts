import type {
  ServerContext,
  SummarizeArticleRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import {
  CACHE_TTL_SECONDS,
  deduplicateHeadlines,
  buildArticlePrompts,
  getProviderCredentials,
  getCacheKey,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { logLocalLlmRequest } from '../../../_shared/local-llm-log';

// ======================================================================
// Reasoning preamble detection
// ======================================================================

export const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
export const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

export function hasReasoningPreamble(text: string): boolean {
  const trimmed = text.trim();
  return TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed);
}

function usesMaxCompletionTokens(provider: string, model: string): boolean {
  if (provider !== 'openai') return false;
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
  );
}

function usesDefaultSamplingOnly(provider: string, model: string): boolean {
  // OpenAI reasoning/newer models may only support default sampling params.
  if (provider !== 'openai') return false;
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
  );
}

function buildTokenLimit(provider: string, model: string, maxTokens: number): Record<string, number> {
  if (usesMaxCompletionTokens(provider, model)) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function getProviderTimeoutMs(provider: string): number {
  if (provider === 'ollama') {
    return parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS) ?? 120_000;
  }
  return parsePositiveInt(process.env.LLM_UPSTREAM_TIMEOUT_MS) ?? 30_000;
}

// ======================================================================
// SummarizeArticle: Multi-provider LLM summarization with Redis caching
// Ported from api/_summarize-handler.js
// ======================================================================

export async function summarizeArticle(
  _ctx: ServerContext,
  req: SummarizeArticleRequest,
): Promise<SummarizeArticleResponse> {
  const { provider, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = req;

  // Input sanitization (M-14 fix): limit headline count and length
  const MAX_HEADLINES = 10;
  const MAX_HEADLINE_LEN = 500;
  const MAX_GEO_CONTEXT_LEN = 2000;
  const headlines = (req.headlines || [])
    .slice(0, MAX_HEADLINES)
    .map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : '');
  const sanitizedGeoContext = typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '';

  // Provider credential check
  const skipReasons: Record<string, string> = {
    ollama: 'OLLAMA_API_URL not configured',
    openai: 'OPENAI_API_KEY not configured',
    groq: 'GROQ_API_KEY not configured',
    openrouter: 'OPENROUTER_API_KEY not configured',
  };

  const credentials = getProviderCredentials(provider);
  if (!credentials) {
    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: true,
      skipped: true,
      reason: skipReasons[provider] || `Unknown provider: ${provider}`,
      error: '',
      errorType: '',
    };
  }

  const { apiUrl, model, headers: providerHeaders, extraBody } = credentials;

  // Request validation
  if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: false,
      skipped: false,
      reason: '',
      error: 'Headlines array required',
      errorType: 'ValidationError',
    };
  }

  try {
    const cacheKey = getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang);

    // Single atomic call — source tracking happens inside cachedFetchJsonWithMeta,
    // eliminating the TOCTOU race between a separate getCachedJson and cachedFetchJson.
    const { data: result, source } = await cachedFetchJsonWithMeta<{ summary: string; model: string; tokens: number }>(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 5));
        const { systemPrompt, userPrompt } = buildArticlePrompts(headlines, uniqueHeadlines, {
          mode,
          geoContext: sanitizedGeoContext,
          variant,
          lang,
        });

        const completionLimit = 100;
        const buildBasePayload = (includeSampling: boolean) => ({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...(includeSampling ? { temperature: 0.3, top_p: 0.9 } : {}),
          ...extraBody,
        });
        const basePayload = buildBasePayload(!usesDefaultSamplingOnly(provider, model));
        const initialPayload = {
          ...basePayload,
          ...buildTokenLimit(provider, model, completionLimit),
        };

        logLocalLlmRequest('summarize-article', provider, apiUrl, model);
        let response = await fetch(apiUrl, {
          method: 'POST',
          headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
          body: JSON.stringify(initialPayload),
          signal: AbortSignal.timeout(getProviderTimeoutMs(provider)),
        });

        if (!response.ok) {
          let errorText = await response.text();

          // OpenAI compatibility fallback for models that require max_completion_tokens.
          const shouldRetryWithCompletionTokens = (
            provider === 'openai'
            && response.status === 400
            && /max_tokens/i.test(errorText)
            && /max_completion_tokens/i.test(errorText)
          );
          const shouldRetryWithoutSampling = (
            provider === 'openai'
            && response.status === 400
            && /temperature/i.test(errorText)
            && /default/i.test(errorText)
          );

          if (shouldRetryWithCompletionTokens || shouldRetryWithoutSampling) {
            const retryPayload = buildBasePayload(false);
            logLocalLlmRequest('summarize-article-retry', provider, apiUrl, model);
            response = await fetch(apiUrl, {
              method: 'POST',
              headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
              body: JSON.stringify({
                ...retryPayload,
                ...buildTokenLimit(provider, model, completionLimit),
              }),
              signal: AbortSignal.timeout(getProviderTimeoutMs(provider)),
            });
            if (response.ok) {
              errorText = '';
            } else {
              errorText = await response.text();
            }
          }

          if (!response.ok) {
            console.error(`[SummarizeArticle:${provider}] API error:`, response.status, errorText);
            throw new Error(response.status === 429 ? 'Rate limited' : `${provider} API error`);
          }
        }

        const data = await response.json() as any;
        const tokens = (data.usage?.total_tokens as number) || 0;
        const message = data.choices?.[0]?.message;
        let rawContent = typeof message?.content === 'string' ? message.content.trim() : '';

        rawContent = rawContent
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
          .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
          .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
          .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
          .trim();

        // Strip unterminated thinking blocks (no closing tag)
        rawContent = rawContent
          .replace(/<think>[\s\S]*/gi, '')
          .replace(/<\|thinking\|>[\s\S]*/gi, '')
          .replace(/<reasoning>[\s\S]*/gi, '')
          .replace(/<reflection>[\s\S]*/gi, '')
          .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
          .trim();

        if (['brief', 'analysis'].includes(mode) && rawContent.length < 20) {
          console.warn(`[SummarizeArticle:${provider}] Output too short after stripping (${rawContent.length} chars), rejecting`);
          return null;
        }

        if (['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
          console.warn(`[SummarizeArticle:${provider}] Reasoning preamble detected, rejecting`);
          return null;
        }

        return rawContent ? { summary: rawContent, model, tokens } : null;
      },
    );

    if (result?.summary) {
      return {
        summary: result.summary,
        model: result.model || model,
        provider: source === 'cache' ? 'cache' : provider,
        cached: source === 'cache',
        tokens: source === 'cache' ? 0 : (result.tokens || 0),
        fallback: false,
        skipped: false,
        reason: '',
        error: '',
        errorType: '',
      };
    }

    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: true,
      skipped: false,
      reason: '',
      error: 'Empty response',
      errorType: '',
    };

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SummarizeArticle:${provider}] Error:`, error.name, error.message);
    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: true,
      skipped: false,
      reason: '',
      error: error.message,
      errorType: error.name,
    };
  }
}
