declare const process: { env: Record<string, string | undefined> };
const LOCAL_LLM_QUEUE_VERBOSE_LOGS = process.env.LOCAL_LLM_QUEUE_VERBOSE_LOGS === 'true';

interface QueueTask {
  scope: string;
  priority: number;
  seq: number;
  enqueuedAt: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

let activeCount = 0;
const pendingTasks: QueueTask[] = [];
let nextSeq = 0;

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function getQueueSettings(): { maxConcurrency: number; maxPending: number; waitTimeoutMs: number } {
  const maxConcurrency = parsePositiveInt(process.env.LOCAL_LLM_MAX_CONCURRENCY) ?? 1;
  const maxPending = parsePositiveInt(process.env.LOCAL_LLM_QUEUE_MAX_PENDING) ?? 16;
  const waitTimeoutMs = parsePositiveInt(process.env.LOCAL_LLM_QUEUE_WAIT_MS) ?? 120_000;
  return {
    maxConcurrency: Math.max(1, maxConcurrency),
    maxPending: Math.max(1, maxPending),
    waitTimeoutMs: Math.max(1000, waitTimeoutMs),
  };
}

function parseScopePriorityMap(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  const entries = raw.split(',').map((v) => v.trim()).filter(Boolean);
  for (const entry of entries) {
    const [scopeRaw, valueRaw] = entry.split(':').map((v) => v.trim());
    if (!scopeRaw || !valueRaw) continue;
    const parsed = Number(valueRaw);
    if (!Number.isFinite(parsed)) continue;
    out[scopeRaw] = Math.floor(parsed);
  }
  return out;
}

const DEFAULT_SCOPE_PRIORITY: Record<string, number> = {
  // Shared board-level insights (cache keys shared by all users)
  'timeline-briefs': 300,
  'summarize-article': 220,
  // User question flow (less globally reusable)
  'recent-events-qa': 120,
  'deduct-situation': 80,
};

const ENV_SCOPE_PRIORITY = parseScopePriorityMap(process.env.LOCAL_LLM_SCOPE_PRIORITIES);

function resolveScopePriority(scope: string): number {
  if (scope in ENV_SCOPE_PRIORITY) return ENV_SCOPE_PRIORITY[scope]!;
  return DEFAULT_SCOPE_PRIORITY[scope] ?? 100;
}

function removePendingTask(task: QueueTask): void {
  const idx = pendingTasks.indexOf(task);
  if (idx >= 0) pendingTasks.splice(idx, 1);
}

function runTask(task: QueueTask): void {
  activeCount += 1;
  if (task.timeoutId) {
    clearTimeout(task.timeoutId);
    task.timeoutId = null;
  }

  const waitMs = Date.now() - task.enqueuedAt;
  if (LOCAL_LLM_QUEUE_VERBOSE_LOGS && waitMs >= 1000) {
    console.log(`[LocalLLM][Queue] ${task.scope} waited ${waitMs}ms (active=${activeCount}, pending=${pendingTasks.length})`);
  }

  task.run()
    .then(task.resolve, task.reject)
    .finally(() => {
      activeCount = Math.max(0, activeCount - 1);
      drainQueue();
    });
}

function drainQueue(): void {
  const { maxConcurrency } = getQueueSettings();
  while (activeCount < maxConcurrency && pendingTasks.length > 0) {
    const next = pendingTasks.shift();
    if (!next) break;
    runTask(next);
  }
}

export function runWithLocalLlmQueue<T>(scope: string, run: () => Promise<T>): Promise<T> {
  const { maxConcurrency, maxPending, waitTimeoutMs } = getQueueSettings();

  return new Promise<T>((resolve, reject) => {
    const task: QueueTask = {
      scope,
      priority: resolveScopePriority(scope),
      seq: nextSeq++,
      enqueuedAt: Date.now(),
      run: () => run() as Promise<unknown>,
      resolve: value => resolve(value as T),
      reject,
      timeoutId: null,
    };

    if (activeCount < maxConcurrency && pendingTasks.length === 0) {
      runTask(task);
      return;
    }

    if (pendingTasks.length >= maxPending) {
      reject(new Error(`Local LLM queue full (${pendingTasks.length}/${maxPending})`));
      return;
    }

    task.timeoutId = setTimeout(() => {
      removePendingTask(task);
      reject(new Error(`Local LLM queue wait timeout (${waitTimeoutMs}ms)`));
    }, waitTimeoutMs);

    const insertAt = pendingTasks.findIndex((existing) => {
      if (task.priority !== existing.priority) return task.priority > existing.priority;
      return task.seq < existing.seq;
    });
    if (insertAt === -1) pendingTasks.push(task);
    else pendingTasks.splice(insertAt, 0, task);
    drainQueue();
  });
}

export function getLocalLlmQueueStats(): { active: number; pending: number } {
  return { active: activeCount, pending: pendingTasks.length };
}
