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
