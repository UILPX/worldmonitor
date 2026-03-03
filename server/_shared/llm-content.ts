function collectText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const merged = value
      .map((entry) => collectText(entry))
      .filter(Boolean)
      .join('\n')
      .trim();
    return merged;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const preferredKeys = [
    'text',
    'output_text',
    'content',
    'value',
    'answer',
    'response',
    'completion',
    'generated_text',
  ];
  for (const key of preferredKeys) {
    const piece = collectText(record[key]);
    if (piece) parts.push(piece);
  }

  return parts.join('\n').trim();
}

function readObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function getLlmFinishReason(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice0 = choices[0];
  if (!choice0 || typeof choice0 !== 'object') return '';
  const finishReason = (choice0 as Record<string, unknown>).finish_reason;
  return typeof finishReason === 'string' ? finishReason.trim() : '';
}

export function isLlmLengthFinish(payload: unknown): boolean {
  return getLlmFinishReason(payload).toLowerCase() === 'length';
}

export function extractLlmResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const root = payload as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];

  for (const choiceValue of choices) {
    if (!choiceValue || typeof choiceValue !== 'object') continue;
    const choice = choiceValue as Record<string, unknown>;
    const message = readObjectField(choice, 'message');
    const delta = readObjectField(choice, 'delta');

    const candidates: unknown[] = [
      message?.content,
      message?.answer,
      choice.text,
      choice.response,
      delta?.content,
      delta?.text,
    ];

    for (const candidate of candidates) {
      const text = collectText(candidate);
      if (text) return text;
    }
  }

  const rootCandidates: unknown[] = [
    root.output_text,
    root.content,
    readObjectField(root, 'message')?.content,
    root.response,
    root.answer,
    root.generated_text,
    root.output,
  ];

  for (const candidate of rootCandidates) {
    const text = collectText(candidate);
    if (text) return text;
  }

  return '';
}

function extractReasoningText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const root = payload as Record<string, unknown>;

  const choice0 = Array.isArray(root.choices) && root.choices.length > 0 && typeof root.choices[0] === 'object'
    ? (root.choices[0] as Record<string, unknown>)
    : null;
  const message = choice0 ? readObjectField(choice0, 'message') : null;

  const candidates: unknown[] = [
    message?.reasoning_content,
    message?.reasoning,
    readObjectField(root, 'message')?.reasoning_content,
    readObjectField(root, 'message')?.reasoning,
    root.reasoning_content,
    root.reasoning,
  ];

  for (const candidate of candidates) {
    const text = collectText(candidate);
    if (text) return text;
  }
  return '';
}

function stripReasoningMarkup(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .trim();
}

export function extractFinalAnswerFromReasoning(payload: unknown): string {
  const raw = stripReasoningMarkup(extractReasoningText(payload));
  if (!raw) return '';

  const match = raw.match(/(?:\*\*)?\s*(final answer|final|最终答案|答案)\s*(?:\*\*)?\s*[:：]\s*([\s\S]+)$/im);
  if (!match) return '';
  return (match[2] || '').trim();
}
