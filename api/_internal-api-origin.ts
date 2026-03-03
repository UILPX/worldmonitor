declare const process: { env: Record<string, string | undefined> };

function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // Some proxies may produce invalid default-port combos like https://host:80.
    if ((url.protocol === 'https:' && url.port === '80') || (url.protocol === 'http:' && url.port === '443')) {
      url.port = '';
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isPrivateOrLocalHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost'
    || normalized.startsWith('127.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}

function withScheme(host: string, fallbackProtocol: string): string {
  const cleanHost = host.trim();
  if (!cleanHost) return '';
  if (cleanHost.includes('://')) return cleanHost;

  const scheme = isPrivateOrLocalHost(cleanHost)
    ? 'http'
    : (fallbackProtocol === 'http' ? 'http' : 'https');

  return `${scheme}://${cleanHost}`;
}

export function buildApiBaseOrigins(req: Request): string[] {
  const url = new URL(req.url);
  const protocol = url.protocol.replace(':', '');
  const out = new Set<string>();

  const add = (candidate: string | null | undefined): void => {
    const normalized = normalizeOrigin(candidate);
    if (normalized) out.add(normalized);
  };

  add(process.env.WORLDMONITOR_INTERNAL_BASE_URL);
  add(url.origin);

  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || '';
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedHost) {
    const scheme = forwardedProto === 'http' || forwardedProto === 'https'
      ? `${forwardedProto}://${forwardedHost}`
      : withScheme(forwardedHost, protocol);
    add(scheme);
  }

  const host = req.headers.get('host')?.split(',')[0]?.trim() || '';
  if (host) add(withScheme(host, protocol));

  const port = process.env.PORT || '3000';
  add(`http://127.0.0.1:${port}`);
  add(`http://localhost:${port}`);

  return [...out];
}
