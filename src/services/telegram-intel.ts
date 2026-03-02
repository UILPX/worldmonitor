import { proxyUrl } from '@/utils';
import { isDesktopRuntime } from '@/services/runtime';

export interface TelegramItem {
  id: string;
  source: 'telegram';
  channel: string;
  channelTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
}

export interface TelegramFeedResponse {
  source: string;
  earlySignal: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  items: TelegramItem[];
}

export const TELEGRAM_TOPICS = [
  { id: 'all', labelKey: 'components.telegramIntel.filterAll' },
  { id: 'breaking', labelKey: 'components.telegramIntel.filterBreaking' },
  { id: 'conflict', labelKey: 'components.telegramIntel.filterConflict' },
  { id: 'alerts', labelKey: 'components.telegramIntel.filterAlerts' },
  { id: 'osint', labelKey: 'components.telegramIntel.filterOsint' },
  { id: 'politics', labelKey: 'components.telegramIntel.filterPolitics' },
  { id: 'middleeast', labelKey: 'components.telegramIntel.filterMiddleeast' },
] as const;

let cachedResponse: TelegramFeedResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000;

function telegramFeedUrl(limit: number): string {
  const path = `/api/telegram-feed?limit=${limit}`;
  return isDesktopRuntime() ? proxyUrl(path) : path;
}

export async function fetchTelegramFeed(limit = 50): Promise<TelegramFeedResponse> {
  if (cachedResponse && Date.now() - cachedAt < CACHE_TTL) return cachedResponse;

  const res = await fetch(telegramFeedUrl(limit));
  if (!res.ok) {
    const raw = await res.text();
    let detail = '';
    try {
      const parsed = JSON.parse(raw) as { error?: string; reason?: string };
      detail = String(parsed.error || parsed.reason || '').trim();
    } catch {
      detail = raw.trim();
    }
    throw new Error(`Telegram feed ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const json: TelegramFeedResponse = await res.json();
  cachedResponse = json;
  cachedAt = Date.now();
  return json;
}

export function formatTelegramTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}
