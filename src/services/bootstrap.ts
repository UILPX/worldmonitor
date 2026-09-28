import type { RuntimeFeatureId } from './runtime-config';

const hydrationCache = new Map<string, unknown>();
type FeatureAvailabilityMap = Partial<Record<RuntimeFeatureId, boolean>>;

interface BootstrapCapabilities {
  features?: FeatureAvailabilityMap;
}

let bootstrapCapabilities: BootstrapCapabilities | null = null;

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

export function getBootstrapCapabilities(): BootstrapCapabilities | null {
  return bootstrapCapabilities;
}

function sanitizeFeatureAvailability(raw: unknown): FeatureAvailabilityMap {
  if (!raw || typeof raw !== 'object') return {};
  const sanitized: Record<string, boolean> = {};
  for (const [featureId, available] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof available === 'boolean') {
      sanitized[featureId] = available;
    }
  }
  return sanitized as FeatureAvailabilityMap;
}

export async function fetchBootstrapData(): Promise<void> {
  try {
    const resp = await fetch('/api/bootstrap', {
      signal: AbortSignal.timeout(800),
    });
    if (!resp.ok) return;
    const payload = await resp.json() as {
      data?: Record<string, unknown>;
      capabilities?: BootstrapCapabilities;
    };
    const data = payload.data ?? {};
    const features = sanitizeFeatureAvailability(payload.capabilities?.features);
    bootstrapCapabilities = { features };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) {
        hydrationCache.set(k, v);
      }
    }
  } catch {
    // silent — panels fall through to individual calls
    bootstrapCapabilities = null;
  }
}
