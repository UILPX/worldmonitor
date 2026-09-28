const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

const BROWSER_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
    /^https?:\/\/10(?:\.\d{1,3}){3}(?::\d+)?$/,
    /^https?:\/\/192\.168(?:\.\d{1,3}){2}(?::\d+)?$/,
    /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}(?::\d+)?$/,
  ]),
];

function parseConfiguredOrigins(rawValue) {
  const values = String(rawValue || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const out = new Set();
  for (const value of values) {
    try {
      out.add(new URL(value).origin);
    } catch {
      // Ignore invalid configured origin values.
    }
  }
  return out;
}

const EXTRA_TRUSTED_ORIGINS = parseConfiguredOrigins(
  process.env.WORLDMONITOR_TRUSTED_ORIGINS || process.env.EXTRA_ALLOWED_ORIGINS || '',
);
const EXTRA_TRUSTED_HOSTS = new Set(
  Array.from(EXTRA_TRUSTED_ORIGINS)
    .map((origin) => {
      try {
        return new URL(origin).host.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean),
);
const EXTRA_TRUSTED_HOSTNAMES = new Set(
  Array.from(EXTRA_TRUSTED_ORIGINS)
    .map((origin) => {
      try {
        return new URL(origin).hostname.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean),
);

function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isTrustedBrowserOrigin(origin) {
  if (!origin) return false;
  if (BROWSER_ORIGIN_PATTERNS.some(p => p.test(origin))) return true;
  try {
    return EXTRA_TRUSTED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function extractOriginFromReferer(referer) {
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

function isLocalHostHeader(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).split(',')[0]?.trim().toLowerCase() || '';
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

function normalizeHostHeader(hostHeader) {
  return String(hostHeader || '').split(',')[0]?.trim().toLowerCase() || '';
}

function isConfiguredTrustedHost(hostHeader) {
  const host = normalizeHostHeader(hostHeader);
  const hostname = extractHostnameFromHostHeader(hostHeader).toLowerCase();
  if (!host && !hostname) return false;
  return EXTRA_TRUSTED_HOSTS.has(host) || EXTRA_TRUSTED_HOSTNAMES.has(hostname);
}

function isLocalRequestUrl(urlValue) {
  if (!urlValue) return false;
  try {
    const hostname = new URL(urlValue).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function isPrivateHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(h)) return true;
  return false;
}

function extractHostnameFromHostHeader(hostHeader) {
  const raw = String(hostHeader || '').split(',')[0]?.trim() || '';
  if (!raw) return '';
  return raw.includes(':') ? raw.split(':')[0] || '' : raw;
}

export function validateApiKey(req) {
  const key = req.headers.get('X-WorldMonitor-Key');
  // Same-origin browser requests don't send Origin (per CORS spec).
  // Fall back to Referer to identify trusted same-origin callers.
  const origin = req.headers.get('Origin') || extractOriginFromReferer(req.headers.get('Referer')) || '';
  const host = req.headers.get('X-Forwarded-Host') || req.headers.get('Host') || '';
  const localUrl = isLocalRequestUrl(req.url);
  const hostName = extractHostnameFromHostHeader(host);
  const allowPrivateDevHosts = process.env.NODE_ENV !== 'production' && isPrivateHost(hostName);
  const allowTrustedHostFallback = isConfiguredTrustedHost(host);

  // Local dev (docker/vercel dev) can omit Origin/Referer on internal fetches.
  // Trust localhost host headers to avoid false 401 for keyed routes.
  if (localUrl || isLocalHostHeader(host) || allowPrivateDevHosts) {
    if (key) {
      const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
      if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: false };
  }

  // Desktop app — always require API key
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
    if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // Trusted browser origin (worldmonitor.app, Vercel previews, localhost dev) — no key needed
  if (isTrustedBrowserOrigin(origin)) {
    if (key) {
      const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
      if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: false };
  }

  // Trusted-host fallback for same-origin requests that omit Origin/Referer behind reverse proxies.
  if (!origin && allowTrustedHostFallback) {
    if (key) {
      const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
      if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: false };
  }

  // Explicit key provided from unknown origin — validate it
  if (key) {
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
    if (!validKeys.includes(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // No origin, no key — require API key (blocks unauthenticated curl/scripts)
  return { valid: false, required: true, error: 'API key required' };
}
