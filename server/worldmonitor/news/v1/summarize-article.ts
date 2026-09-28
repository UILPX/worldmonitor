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
import {
  logLlmRawFetchError,
  logLlmRawRequest,
  logLlmRawResponse,
  logLocalLlmFailure,
  logLocalLlmRequest,
} from '../../../_shared/local-llm-log';
import { runWithLocalLlmQueue } from '../../../_shared/local-llm-queue';
import { extractFinalAnswerFromReasoning, extractLlmResponseText, isLlmLengthFinish } from '../../../_shared/llm-content';

// ======================================================================
// Reasoning preamble detection
// ======================================================================

export const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
export const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

export function hasReasoningPreamble(text: string): boolean {
  const trimmed = text.trim();
  return TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed);
}

function normalizeSummaryLanguage(mode: string, lang: string): string {
  if (mode === 'translate') {
    return lang || '';
  }
  return lang || 'en';
}

function isChineseLanguage(lang: string): boolean {
  const normalized = (lang || '').toLowerCase();
  return normalized === 'zh' || normalized.startsWith('zh-');
}

function hasMinimumChinese(text: string, minCount: number): boolean {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk >= minCount;
}

function hasThinkingScaffold(text: string): boolean {
  const trimmed = text.trim();
  return /(thinking process|analyze the request|current date|constraints|^\s*\*\*task\*\*)/im.test(trimmed);
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

function getProviderTimeoutMs(provider: string, mode: string): number {
  if (provider === 'ollama') {
    const modeDefault = mode === 'analysis' ? 60_000 : 45_000;
    return parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS) ?? modeDefault;
  }
  return parsePositiveInt(process.env.LLM_UPSTREAM_TIMEOUT_MS) ?? 30_000;
}

function getCompletionLimit(provider: string, model: string): number {
  if (provider === 'ollama') {
    return parsePositiveInt(process.env.SUMMARIZE_OLLAMA_FORCE_MAX_TOKENS)
      ?? parsePositiveInt(process.env.OLLAMA_FORCE_MAX_TOKENS)
      ?? 0;
  }
  if (usesMaxCompletionTokens(provider, model)) {
    return parsePositiveInt(process.env.SUMMARIZE_OPENAI_MAX_COMPLETION_TOKENS) ?? 600;
  }
  return parsePositiveInt(process.env.SUMMARIZE_MAX_TOKENS) ?? 120;
}

function buildOllamaChatMessages(systemPrompt: string, userPrompt: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
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
  const effectiveLang = normalizeSummaryLanguage(mode, lang);

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
    const cacheKey = getCacheKey(headlines, mode, sanitizedGeoContext, variant, effectiveLang);

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
          lang: effectiveLang,
        });

        const completionLimit = getCompletionLimit(provider, model);
        const buildBasePayload = (includeSampling: boolean) => ({
          model,
          messages: provider === 'ollama'
            ? buildOllamaChatMessages(systemPrompt, userPrompt)
            : [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          ...(includeSampling ? { temperature: 0.3, top_p: 0.9 } : {}),
          ...extraBody,
        });

        const parseResponseContent = (data: any): { content: string; tokens: number; payload: unknown } => {
          const tokens = (data.usage?.total_tokens as number) || 0;
          const message = data.choices?.[0]?.message;
          let rawContent = extractLlmResponseText(data);
          if (!rawContent) {
            rawContent = extractFinalAnswerFromReasoning(data);
          }
          if (!rawContent && typeof message?.content === 'string') {
            rawContent = message.content.trim();
          }
          const rawOriginal = rawContent;

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

          // If strict block stripping removed everything, keep text and only strip markers.
          if (!rawContent && rawOriginal) {
            rawContent = rawOriginal
              .replace(/<\/?think>/gi, '')
              .replace(/<\|thinking\|>/gi, '')
              .replace(/<\|\/thinking\|>/gi, '')
              .replace(/<\/?reasoning>/gi, '')
              .replace(/<\/?reflection>/gi, '')
              .replace(/<\|begin_of_thought\|>/gi, '')
              .replace(/<\|end_of_thought\|>/gi, '')
              .trim();
          }

          return { content: rawContent, tokens, payload: data };
        };

        const invokeProvider = async (): Promise<{ summary: string; model: string; tokens: number } | null> => {
          const callWithPayload = async (
            payload: Record<string, unknown>,
            logScope: 'summarize-article' | 'summarize-article-retry',
          ): Promise<{ content: string; tokens: number; payload: unknown }> => {
            logLocalLlmRequest(logScope, provider, apiUrl, model);
            logLlmRawRequest(logScope, provider, apiUrl, model, payload);
            let response: Response;
            try {
              response = await fetch(apiUrl, {
                method: 'POST',
                headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(getProviderTimeoutMs(provider, mode)),
              });
            } catch (error) {
              logLlmRawFetchError(logScope, provider, apiUrl, model, error);
              throw error;
            }
            let rawBody = await response.text();
            logLlmRawResponse(logScope, provider, apiUrl, model, response.status, rawBody);

            if (!response.ok) {
              let errorText = rawBody;

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
                const retryPayload = {
                  ...buildBasePayload(false),
                  ...(completionLimit > 0 ? buildTokenLimit(provider, model, completionLimit) : {}),
                };
                logLocalLlmRequest('summarize-article-retry', provider, apiUrl, model);
                logLlmRawRequest('summarize-article-retry', provider, apiUrl, model, retryPayload);
                try {
                  response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
                    body: JSON.stringify(retryPayload),
                    signal: AbortSignal.timeout(getProviderTimeoutMs(provider, mode)),
                  });
                } catch (error) {
                  logLlmRawFetchError('summarize-article-retry', provider, apiUrl, model, error);
                  throw error;
                }
                rawBody = await response.text();
                logLlmRawResponse('summarize-article-retry', provider, apiUrl, model, response.status, rawBody);
                if (response.ok) {
                  errorText = '';
                } else {
                  errorText = rawBody;
                }
              }

              if (!response.ok) {
                logLocalLlmFailure('summarize-article', provider, model, 'upstream_http_error', {
                  status: response.status,
                  error: errorText,
                }, {
                  status: response.status,
                  mode,
                  variant,
                  lang: effectiveLang,
                });
                throw new Error(response.status === 429 ? 'Rate limited' : `${provider} API error`);
              }
            }

            let data: any;
            try {
              data = JSON.parse(rawBody) as any;
            } catch {
              throw new Error(`${provider} invalid JSON response`);
            }
            return parseResponseContent(data);
          };

          const initialPayload = {
            ...buildBasePayload(!usesDefaultSamplingOnly(provider, model)),
            ...(completionLimit > 0 ? buildTokenLimit(provider, model, completionLimit) : {}),
          };

          let parsed = await callWithPayload(initialPayload, 'summarize-article');
          if (provider === 'ollama' && !parsed.content) {
            const fallbackPayload = {
              ...buildBasePayload(!usesDefaultSamplingOnly(provider, model)),
              ...(completionLimit > 0 ? buildTokenLimit(provider, model, completionLimit) : {}),
            };
            parsed = await callWithPayload(fallbackPayload, 'summarize-article-retry');
          }

          if (
            usesMaxCompletionTokens(provider, model)
            && (!parsed.content || parsed.content.length < 20)
            && isLlmLengthFinish(parsed.payload)
          ) {
            const firstRetryLimit = Math.min(
              2400,
              Math.max(
                completionLimit > 0 ? completionLimit * 2 : 800,
                800,
              ),
            );
            const enlargedPayload = {
              ...buildBasePayload(false),
              ...buildTokenLimit(provider, model, firstRetryLimit),
            };
            parsed = await callWithPayload(enlargedPayload, 'summarize-article-retry');
          }

          if (
            usesMaxCompletionTokens(provider, model)
            && (!parsed.content || parsed.content.length < 20)
            && isLlmLengthFinish(parsed.payload)
          ) {
            const secondRetryLimit = Math.min(
              3600,
              Math.max(
                completionLimit > 0 ? completionLimit * 5 : 1800,
                1800,
              ),
            );
            const secondEnlargedPayload = {
              ...buildBasePayload(false),
              ...buildTokenLimit(provider, model, secondRetryLimit),
            };
            parsed = await callWithPayload(secondEnlargedPayload, 'summarize-article-retry');
          }

          const rawContent = parsed.content;
          let tokens = parsed.tokens;
          const payload = parsed.payload;

          const minAcceptedLength = (provider === 'ollama') ? 2 : 20;
          if (['brief', 'analysis'].includes(mode) && rawContent.length < minAcceptedLength) {
            logLocalLlmFailure('summarize-article', provider, model, 'empty_or_too_short', payload, {
              mode,
              variant,
              lang: effectiveLang,
              contentLen: rawContent.length,
              minAcceptedLength,
            });
            return null;
          }

          if (provider === 'ollama' && hasThinkingScaffold(rawContent)) {
            logLocalLlmFailure('summarize-article', provider, model, 'reasoning_scaffold', payload, {
              mode,
              variant,
              lang: effectiveLang,
              contentLen: rawContent.length,
            });
            return null;
          }

          if (provider !== 'ollama' && ['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
            logLocalLlmFailure('summarize-article', provider, model, 'reasoning_preamble', payload, {
              mode,
              variant,
              lang: effectiveLang,
              contentLen: rawContent.length,
            });
            return null;
          }

          if (mode !== 'translate' && isChineseLanguage(effectiveLang)) {
            const minZhCount = provider === 'ollama' ? 2 : 6;
            if (!hasMinimumChinese(rawContent, minZhCount)) {
              // Last attempt: translate the generated text into target Chinese instead of dropping it outright.
              let translated = '';
              try {
                const translationPayload: Record<string, unknown> = {
                  model,
                  messages: provider === 'ollama'
                    ? buildOllamaChatMessages(
                      'Translate the user text to Simplified Chinese (zh-CN). Output ONLY translated text. Do not add explanation.',
                      rawContent,
                    )
                    : [
                      {
                        role: 'system',
                        content: 'Translate the user text to Simplified Chinese (zh-CN). Output ONLY translated text. Do not add explanation.',
                      },
                      {
                        role: 'user',
                        content: rawContent,
                      },
                    ],
                  ...(usesDefaultSamplingOnly(provider, model) ? {} : { temperature: 0.1, top_p: 0.9 }),
                  ...(completionLimit > 0 ? buildTokenLimit(provider, model, Math.max(160, Math.min(1200, completionLimit))) : {}),
                  ...extraBody,
                };
                const translatedParsed = await callWithPayload(translationPayload, 'summarize-article-retry');
                translated = translatedParsed.content.trim();
                tokens += translatedParsed.tokens;
              } catch {
                translated = '';
              }

              if (translated && hasMinimumChinese(translated, 2)) {
                return { summary: translated, model, tokens };
              }

              logLocalLlmFailure('summarize-article', provider, model, 'non_chinese_output', payload, {
                mode,
                variant,
                lang: effectiveLang,
                contentLen: rawContent.length,
                minZhCount,
                translationRetried: true,
              });
              return null;
            }
          }

          return rawContent ? { summary: rawContent, model, tokens } : null;
        };

        if (provider === 'ollama') {
          return runWithLocalLlmQueue('summarize-article', invokeProvider);
        }

        return invokeProvider();
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

    logLocalLlmFailure('summarize-article', provider, model, 'no_valid_response', undefined, {
      mode,
      variant,
      lang: effectiveLang,
    });
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
    logLocalLlmFailure('summarize-article', provider, model, 'exception', undefined, {
      mode,
      variant,
      lang: effectiveLang,
      name: error.name,
      message: error.message.slice(0, 200),
    });
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
