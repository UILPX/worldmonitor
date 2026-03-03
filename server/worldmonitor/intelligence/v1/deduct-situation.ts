declare const process: { env: Record<string, string | undefined> };

import type {
    ServerContext,
    DeductSituationRequest,
    DeductSituationResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { hashString } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { isLikelyLocalLlmUrl, logLocalLlmRequest } from '../../../_shared/local-llm-log';
import { runWithLocalLlmQueue } from '../../../_shared/local-llm-queue';
import { extractLlmResponseText } from '../../../_shared/llm-content';

const DEDUCT_TIMEOUT_MS = 120_000;
const DEDUCT_CACHE_TTL = 3600;
const DEFAULT_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';

function parsePositiveInt(raw: string | undefined): number | null {
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
}

function usesOpenAiCompletionTokens(apiUrl: string, model: string): boolean {
    if (!/api\.openai\.com/i.test(apiUrl)) return false;
    const normalized = model.toLowerCase();
    return (
        normalized.startsWith('gpt-5')
        || normalized.startsWith('o1')
        || normalized.startsWith('o3')
        || normalized.startsWith('o4')
    );
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

export async function deductSituation(
    _ctx: ServerContext,
    req: DeductSituationRequest,
): Promise<DeductSituationResponse> {
    const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
    const apiUrl = process.env.LLM_API_URL || DEFAULT_API_URL;
    const model = process.env.LLM_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
        return { analysis: '', model: '', provider: 'skipped' };
    }

    const MAX_QUERY_LEN = 500;
    const MAX_GEO_LEN = 2000;

    const query = typeof req.query === 'string' ? req.query.slice(0, MAX_QUERY_LEN).trim() : '';
    const geoContext = typeof req.geoContext === 'string' ? req.geoContext.slice(0, MAX_GEO_LEN).trim() : '';

    if (!query) return { analysis: '', model: '', provider: 'skipped' };

    const cacheKey = `deduct:situation:v1:${hashString(query.toLowerCase() + '|' + geoContext.toLowerCase())}`;

    const cached = await cachedFetchJson<{ analysis: string; model: string; provider: string }>(
        cacheKey,
        DEDUCT_CACHE_TTL,
        async () => {
            try {
                const systemPrompt = `You are a senior geopolitical intelligence analyst and forecaster.
Your task is to DEDUCT the situation in a near timeline (e.g. 24 hours to a few months) based on the user's query.
- Use any provided geographic or intelligence context.
- Be highly analytical, pragmatic, and objective.
- Identify the most likely outcomes, timelines, and second-order impacts.
- Do NOT use typical AI preambles (e.g., "Here is the deduction", "Let me see").
- Output only the final analysis. Do not output thinking steps, reasoning process, or prompt analysis.
- Format your response in clean markdown with concise bullet points where appropriate.`;

                const localLlm = isLikelyLocalLlmUrl(apiUrl);
                let userPrompt = query;
                if (geoContext) {
                    userPrompt += `\n\n### Current Intelligence Context\n${geoContext}`;
                }

                const completionLimit = 1500;
                const payload = {
                    model,
                    messages: localLlm
                        ? buildOllamaChatMessages(systemPrompt, userPrompt)
                        : [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt },
                        ],
                    temperature: 0.3,
                    ...(localLlm ? { think: false } : {}),
                    ...(usesOpenAiCompletionTokens(apiUrl, model)
                        ? { max_completion_tokens: completionLimit }
                        : { max_tokens: completionLimit }),
                };

                const invokeProvider = async (): Promise<{ analysis: string; model: string; provider: string } | null> => {
                    logLocalLlmRequest('deduct-situation', 'llm', apiUrl, model);
                    const resp = await fetch(apiUrl, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                            'User-Agent': CHROME_UA
                        },
                        body: JSON.stringify(payload),
                        signal: AbortSignal.timeout(parsePositiveInt(process.env.LLM_UPSTREAM_TIMEOUT_MS) ?? DEDUCT_TIMEOUT_MS),
                    });

                    if (!resp.ok) return null;

                    const data = await resp.json() as Record<string, unknown>;
                    let raw = extractLlmResponseText(data).trim();
                    if (!raw) return null;

                    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                    return { analysis: raw, model, provider: 'groq' };
                };

                if (localLlm) {
                    return await runWithLocalLlmQueue('deduct-situation', invokeProvider);
                }
                return await invokeProvider();
            } catch (err) {
                console.error('[DeductSituation] Error calling LLM:', err);
                return null;
            }
        }
    );

    if (!cached?.analysis) {
        return { analysis: '', model: '', provider: 'error' };
    }

    return {
        analysis: cached.analysis,
        model: cached.model,
        provider: cached.provider,
    };
}
