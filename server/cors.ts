/**
 * CORS header generation for sebuf edge routes.
 *
 * Keep this aligned with api/_cors.js so /api/{domain}/v1/* and legacy /api/*
 * share the same origin behavior.
 */

declare const process: { env: Record<string, string | undefined> };

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-[a-z0-9]+\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
    /^https?:\/\/10(?:\.\d{1,3}){3}(?::\d+)?$/,
    /^https?:\/\/192\.168(?:\.\d{1,3}){2}(?::\d+)?$/,
    /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}(?::\d+)?$/,
  ]),
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

function parseConfiguredOrigins(rawValue: string | undefined): Set<string> {
  const values = String(rawValue || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const value of values) {
    try {
      out.add(new URL(value).origin);
    } catch {
      // Ignore invalid configured origin values.
    }
  }
  return out;
}

const EXTRA_ALLOWED_ORIGINS = parseConfiguredOrigins(
  process.env.WORLDMONITOR_TRUSTED_ORIGINS || process.env.EXTRA_ALLOWED_ORIGINS || '',
);

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) return true;
  try {
    return EXTRA_ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function isDisallowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
