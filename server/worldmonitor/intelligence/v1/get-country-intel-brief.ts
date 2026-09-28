declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, GROQ_API_URL, GROQ_MODEL, TIER1_COUNTRIES, hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { extractLlmResponseText } from '../../../_shared/llm-content';
import { logLlmRawRequest, logLlmRawResponse } from '../../../_shared/local-llm-log';

// ========================================================================
// Constants
// ========================================================================

const INTEL_CACHE_TTL = 7200;

// ========================================================================
// RPC handler
// ========================================================================

export async function getCountryIntelBrief(
  ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  const empty: GetCountryIntelBriefResponse = {
    countryCode: req.countryCode,
    countryName: '',
    brief: '',
    model: GROQ_MODEL,
    generatedAt: Date.now(),
  };

  if (!req.countryCode) return empty;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return empty;

  let contextSnapshot = '';
  try {
    const url = new URL(ctx.request.url);
    contextSnapshot = (url.searchParams.get('context') || '').trim().slice(0, 4000);
  } catch {
    contextSnapshot = '';
  }

  const contextHash = contextSnapshot ? hashString(contextSnapshot) : 'base';
  const cacheKey = `ci-sebuf:v2:${req.countryCode}:${contextHash}`;
  const countryName = TIER1_COUNTRIES[req.countryCode] || req.countryCode;
  const dateStr = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a senior intelligence analyst providing comprehensive country situation briefs. Current date: ${dateStr}. Provide geopolitical context appropriate for the current date.

Write a concise intelligence brief for the requested country covering:
1. Current Situation - what is happening right now
2. Military & Security Posture
3. Key Risk Factors
4. Regional Context
5. Outlook & Watch Items

Rules:
- Be specific and analytical
- 4-5 paragraphs, 250-350 words
- No speculation beyond what data supports
- Use plain language, not jargon
- If a context snapshot is provided, explicitly reflect each non-zero signal category in the brief`;

  let result: GetCountryIntelBriefResponse | null = null;
  try {
    result = await cachedFetchJson<GetCountryIntelBriefResponse>(cacheKey, INTEL_CACHE_TTL, async () => {
      try {
        const userPromptParts = [
          `Country: ${countryName} (${req.countryCode})`,
        ];
        if (contextSnapshot) {
          userPromptParts.push(`Context snapshot:\n${contextSnapshot}`);
        }

        const payload = {
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPromptParts.join('\n\n') },
          ],
          temperature: 0.4,
          max_tokens: 900,
        };
        logLlmRawRequest('get-country-intel-brief', 'groq', GROQ_API_URL, GROQ_MODEL, payload);
        const resp = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const rawBody = await resp.text();
        logLlmRawResponse('get-country-intel-brief', 'groq', GROQ_API_URL, GROQ_MODEL, resp.status, rawBody);

        if (!resp.ok) return null;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          return null;
        }
        const brief = extractLlmResponseText(data).trim();
        if (!brief) return null;

        return {
          countryCode: req.countryCode,
          countryName,
          brief,
          model: GROQ_MODEL,
          generatedAt: Date.now(),
        };
      } catch {
        return null;
      }
    });
  } catch {
    return empty;
  }

  return result || empty;
}
