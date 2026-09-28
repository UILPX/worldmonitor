declare const process: { env: Record<string, string | undefined> };
const LOCAL_LLM_QUEUE_VERBOSE_LOGS = process.env.LOCAL_LLM_QUEUE_VERBOSE_LOGS === 'true';
const LOCAL_LLM_GLOBAL_LOCK_ENABLED = process.env.LOCAL_LLM_GLOBAL_LOCK_ENABLED !== 'false';

interface QueueTask {
  scope: string;
  priority: number;
  seq: number;
  enqueuedAt: number;
  startedAt: number | null;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface DistributedLockHandle {
  key: string;
  token: string;
}

let activeCount = 0;
const pendingTasks: QueueTask[] = [];
const activeTasks: QueueTask[] = [];
let nextSeq = 0;

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function getQueueSettings(): { maxConcurrency: number; maxPending: number; waitTimeoutMs: number } {
  const maxConcurrency = parsePositiveInt(process.env.LOCAL_LLM_MAX_CONCURRENCY) ?? 1;
  const maxPending = parsePositiveInt(process.env.LOCAL_LLM_QUEUE_MAX_PENDING) ?? 16;
  return {
    maxConcurrency: Math.max(1, maxConcurrency),
    maxPending: Math.max(1, maxPending),
    // Queue waiting must not count as timeout; only LLM upstream call timeout applies.
    waitTimeoutMs: 0,
  };
}

function getRedisPrefix(): string {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

function getDistributedLockKey(): string {
  return `${getRedisPrefix()}${process.env.LOCAL_LLM_GLOBAL_LOCK_KEY || 'local-llm:global-lock'}`;
}

function getDistributedLockTtlMs(): number {
  return parsePositiveInt(process.env.LOCAL_LLM_GLOBAL_LOCK_TTL_MS) ?? 180_000;
}

function getDistributedLockWaitMs(): number {
  return parseNonNegativeInt(process.env.LOCAL_LLM_GLOBAL_LOCK_WAIT_MS) ?? 0;
}

function getDistributedLockPollMs(): number {
  return parsePositiveInt(process.env.LOCAL_LLM_GLOBAL_LOCK_POLL_MS) ?? 300;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquireDistributedLock(
  lockKey: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const auth = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !auth || !LOCAL_LLM_GLOBAL_LOCK_ENABLED) return true;

  try {
    const resp = await fetch(
      `${url}/set/${encodeURIComponent(lockKey)}/${encodeURIComponent(token)}/PX/${ttlMs}/NX`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}` },
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!resp.ok) return true;
    const payload = (await resp.json()) as { result?: string | null };
    return payload.result === 'OK';
  } catch {
    return true;
  }
}

async function acquireDistributedLock(scope: string): Promise<DistributedLockHandle | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const auth = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !auth || !LOCAL_LLM_GLOBAL_LOCK_ENABLED) return null;

  const key = getDistributedLockKey();
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ttlMs = getDistributedLockTtlMs();
  const waitMs = getDistributedLockWaitMs();
  const pollMs = getDistributedLockPollMs();
  const started = Date.now();

  while (waitMs <= 0 || (Date.now() - started) < waitMs) {
    const ok = await tryAcquireDistributedLock(key, token, ttlMs);
    if (ok) {
      if (LOCAL_LLM_QUEUE_VERBOSE_LOGS) {
        const waited = Date.now() - started;
        if (waited >= 500) {
          console.log(`[LocalLLM][Queue] ${scope} acquired global lock after ${waited}ms`);
        }
      }
      return { key, token };
    }
    await sleepMs(pollMs);
  }

  throw new Error(`Local LLM global lock wait timeout (${waitMs}ms)`);
}

async function releaseDistributedLock(handle: DistributedLockHandle | null): Promise<void> {
  if (!handle) return;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const auth = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !auth || !LOCAL_LLM_GLOBAL_LOCK_ENABLED) return;

  try {
    const getResp = await fetch(`${url}/get/${encodeURIComponent(handle.key)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!getResp.ok) return;
    const getPayload = (await getResp.json()) as { result?: string | null };
    if (getPayload.result !== handle.token) return;

    await fetch(`${url}/del/${encodeURIComponent(handle.key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // best-effort unlock
  }
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
  task.startedAt = Date.now();
  activeTasks.push(task);
  if (task.timeoutId) {
    clearTimeout(task.timeoutId);
    task.timeoutId = null;
  }

  const waitMs = Date.now() - task.enqueuedAt;
  if (LOCAL_LLM_QUEUE_VERBOSE_LOGS && waitMs >= 1000) {
    console.log(`[LocalLLM][Queue] ${task.scope} waited ${waitMs}ms (active=${activeCount}, pending=${pendingTasks.length})`);
  }

  (async () => {
    const lockHandle = await acquireDistributedLock(task.scope);
    try {
      return await task.run();
    } finally {
      await releaseDistributedLock(lockHandle);
    }
  })()
    .then(task.resolve, task.reject)
    .finally(() => {
      activeCount = Math.max(0, activeCount - 1);
      const idx = activeTasks.indexOf(task);
      if (idx >= 0) activeTasks.splice(idx, 1);
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
      startedAt: null,
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

    if (waitTimeoutMs > 0) {
      task.timeoutId = setTimeout(() => {
        removePendingTask(task);
        reject(new Error(`Local LLM queue wait timeout (${waitTimeoutMs}ms)`));
      }, waitTimeoutMs);
    }

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

interface QueueTaskView {
  scope: string;
  priority: number;
  seq: number;
  enqueuedAt: number;
  startedAt: number | null;
  waitMs: number;
  runMs: number;
}

export function getLocalLlmQueueSnapshot(): {
  active: QueueTaskView[];
  pending: QueueTaskView[];
  stats: { active: number; pending: number };
  updatedAt: number;
} {
  const now = Date.now();
  const toView = (task: QueueTask): QueueTaskView => ({
    scope: task.scope,
    priority: task.priority,
    seq: task.seq,
    enqueuedAt: task.enqueuedAt,
    startedAt: task.startedAt,
    waitMs: Math.max(0, (task.startedAt ?? now) - task.enqueuedAt),
    runMs: task.startedAt ? Math.max(0, now - task.startedAt) : 0,
  });

  return {
    active: activeTasks.map(toView),
    pending: pendingTasks.map(toView),
    stats: { active: activeCount, pending: pendingTasks.length },
    updatedAt: now,
  };
}
