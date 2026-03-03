import { extractFinalAnswerFromReasoning, extractLlmResponseText } from './llm-content';
declare const process: { env: Record<string, string | undefined> };

const LOCAL_LLM_VERBOSE_LOGS = process.env.LOCAL_LLM_VERBOSE_LOGS === 'true';

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return false;
  }
  const p0 = parts[0] ?? -1;
  const p1 = parts[1] ?? -1;
  if (p0 === 10) return true;
  if (p0 === 127) return true;
  if (p0 === 192 && p1 === 168) return true;
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
  return false;
}

export function isLikelyLocalLlmUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    if (host.endsWith('.local')) return true;
    if (isPrivateIpv4(host)) return true;
    return false;
  } catch {
    return false;
  }
}

export function logLocalLlmRequest(scope: string, provider: string, apiUrl: string, model: string): void {
  if (!LOCAL_LLM_VERBOSE_LOGS) return;
  if (!isLikelyLocalLlmUrl(apiUrl)) return;
  try {
    const target = new URL(apiUrl);
    const endpoint = `${target.protocol}//${target.host}${target.pathname}`;
    const ts = new Date().toISOString();
    console.log(`[LocalLLM][${scope}] ${ts} request sent | provider=${provider} | model=${model} | endpoint=${endpoint}`);
  } catch {
    const ts = new Date().toISOString();
    console.log(`[LocalLLM][${scope}] ${ts} request sent | provider=${provider} | model=${model}`);
  }
}

function compactText(raw: string, maxLen: number): string {
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}…`;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => collectText(entry))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const fields: unknown[] = [
    record.text,
    record.content,
    record.output_text,
    record.refusal,
    record.message,
    record.reason,
    record.value,
  ];
  return fields
    .map((entry) => collectText(entry))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function safeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function summarizeLlmPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return `payload_type=${typeof payload}`;
  }

  const root = payload as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice0 = safeObject(choices[0]);
  const message = choice0 ? safeObject(choice0.message) : null;
  const errorObj = safeObject(root.error);

  const content = extractLlmResponseText(payload).trim();
  const finalFromReasoning = extractFinalAnswerFromReasoning(payload).trim();
  const refusal = (
    collectText(message?.refusal)
    || collectText(choice0?.refusal)
    || collectText(root.refusal)
    || collectText(errorObj?.message)
  ).trim();
  const reasoningRaw = (
    (typeof message?.reasoning_content === 'string' ? message.reasoning_content : '')
    || (typeof message?.reasoning === 'string' ? message.reasoning : '')
    || (typeof root.reasoning_content === 'string' ? root.reasoning_content : '')
    || (typeof root.reasoning === 'string' ? root.reasoning : '')
  ).trim();
  const finishReason = typeof choice0?.finish_reason === 'string' ? choice0.finish_reason : '';

  const summary = {
    rootKeys: Object.keys(root).slice(0, 20),
    choicesCount: choices.length,
    choiceKeys: choice0 ? Object.keys(choice0).slice(0, 20) : [],
    messageKeys: message ? Object.keys(message).slice(0, 20) : [],
    finishReason,
    contentLen: content.length,
    content: compactText(content, 260),
    refusalLen: refusal.length,
    refusal: compactText(refusal, 260),
    reasoningLen: reasoningRaw.length,
    reasoning: compactText(reasoningRaw, 260),
    finalAnswerLen: finalFromReasoning.length,
    finalAnswer: compactText(finalFromReasoning, 260),
    errorType: typeof errorObj?.type === 'string' ? errorObj.type : '',
    errorCode: typeof errorObj?.code === 'string' ? errorObj.code : '',
  };

  try {
    return JSON.stringify(summary);
  } catch {
    return 'payload_summary_unserializable';
  }
}

export function logLocalLlmFailure(
  scope: string,
  provider: string,
  model: string,
  reason: string,
  payload?: unknown,
  context?: Record<string, string | number | boolean | undefined>,
): void {
  const ts = new Date().toISOString();
  const ctx = context
    ? Object.entries(context)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ')
    : '';
  console.error(
    `[LocalLLM][${scope}] ${ts} failure | provider=${provider} model=${model} reason=${reason}${ctx ? ` ${ctx}` : ''}`,
  );
  if (payload !== undefined) {
    console.error(`[LocalLLM][${scope}] payload_summary=${summarizeLlmPayload(payload)}`);
  }
}
