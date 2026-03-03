import { SITE_VARIANT } from '@/config';
import { h, replaceChildren } from '@/utils/dom-utils';

type StatusLevel = 'ok' | 'warning' | 'error' | 'disabled';

interface FeedStatus {
  name: string;
  lastUpdate: Date | null;
  status: StatusLevel;
  itemCount: number;
  errorMessage?: string;
}

interface ApiStatus {
  name: string;
  status: StatusLevel;
  latency?: number;
}

const DEBUG_LOCAL_STORAGE_KEYS = [
  'worldmonitor-variant',
  'panel-order',
  'worldmonitor-panel-spans',
  'worldmonitor-panel-col-spans',
  'worldmonitor-panels',
  'worldmonitor-layers',
  'worldmonitor-disabled-feeds',
  'worldmonitor-live-channels',
  'map-height',
  'map-pinned',
  'worldmonitor-request-mode',
] as const;

// Allowlists for each variant
const TECH_FEEDS = new Set([
  'Tech', 'Ai', 'Startups', 'Vcblogs', 'RegionalStartups',
  'Unicorns', 'Accelerators', 'Security', 'Policy', 'Layoffs',
  'Finance', 'Hardware', 'Cloud', 'Dev', 'Tech Events', 'Crypto',
  'Markets', 'Events', 'Producthunt', 'Funding', 'Polymarket',
  'Cyber Threats'
]);
const TECH_APIS = new Set([
  'RSS Proxy', 'Finnhub', 'CoinGecko', 'Tech Events API', 'Service Status', 'Polymarket',
  'Cyber Threats API'
]);

const WORLD_FEEDS = new Set([
  'Politics', 'Middleeast', 'Tech', 'Ai', 'Finance',
  'Gov', 'Intel', 'Layoffs', 'Thinktanks', 'Energy',
  'Polymarket', 'Weather', 'NetBlocks', 'Shipping', 'Military',
  'Cyber Threats', 'GPS Jam'
]);
const WORLD_APIS = new Set([
  'RSS2JSON', 'Finnhub', 'CoinGecko', 'Polymarket', 'USGS', 'FRED',
  'AISStream', 'GDELT Doc', 'EIA', 'USASpending', 'PizzINT', 'FIRMS',
  'Cyber Threats API', 'BIS', 'WTO', 'SupplyChain'
]);

import { t } from '../services/i18n';
import { Panel } from './Panel';

export class StatusPanel extends Panel {
  private isOpen = false;
  private feeds: Map<string, FeedStatus> = new Map();
  private apis: Map<string, ApiStatus> = new Map();
  private allowedFeeds!: Set<string>;
  private allowedApis!: Set<string>;

  constructor() {
    super({ id: 'status', title: t('panels.status') });
    // Title is hidden in CSS, we use custom header
    this.init();
  }

  private init(): void {
    this.allowedFeeds = SITE_VARIANT === 'tech' ? TECH_FEEDS : WORLD_FEEDS;
    this.allowedApis = SITE_VARIANT === 'tech' ? TECH_APIS : WORLD_APIS;

    const panel = h('div', { className: 'status-panel hidden' },
      h('div', { className: 'status-panel-header' },
        h('span', null, t('panels.status')),
        h('button', {
          className: 'status-panel-close',
          onClick: () => { this.isOpen = false; panel.classList.add('hidden'); },
        }, '×'),
      ),
      h('div', { className: 'status-panel-content' },
        h('div', { className: 'status-section' },
          h('div', { className: 'status-section-title' }, t('components.status.dataFeeds')),
          h('div', { className: 'feeds-list' }),
        ),
        h('div', { className: 'status-section' },
          h('div', { className: 'status-section-title' }, t('components.status.apiStatus')),
          h('div', { className: 'apis-list' }),
        ),
        h('div', { className: 'status-section' },
          h('div', { className: 'status-section-title' }, t('components.status.storage')),
          h('div', { className: 'storage-info' }),
        ),
      ),
      h('div', { className: 'status-panel-footer' },
        h('div', { className: 'status-panel-actions' },
          h('button', {
            type: 'button',
            className: 'status-panel-action-btn',
            onClick: () => { void this.exportDebugReport(); },
          }, 'Export Debug Report'),
        ),
        h('span', { className: 'last-check' }, t('components.status.updatedAt', { time: this.formatTime(new Date()) })),
      ),
    );

    this.element = h('div', { className: 'status-panel-container' },
      h('button', {
        className: 'status-panel-toggle',
        title: t('components.status.systemStatus'),
        onClick: () => {
          this.isOpen = !this.isOpen;
          panel.classList.toggle('hidden', !this.isOpen);
          if (this.isOpen) this.updateDisplay();
        },
      },
        h('span', { className: 'status-icon' }, '◉'),
      ),
      panel,
    );

    this.initDefaultStatuses();
  }

  private initDefaultStatuses(): void {
    // Initialize all allowed feeds/APIs as disabled
    // They get enabled when App.ts reports data
    this.allowedFeeds.forEach(name => {
      this.feeds.set(name, { name, lastUpdate: null, status: 'disabled', itemCount: 0 });
    });

    this.allowedApis.forEach(name => {
      this.apis.set(name, { name, status: 'disabled' });
    });
  }

  public updateFeed(name: string, status: Partial<FeedStatus>): void {
    // Only track feeds relevant to current variant
    if (!this.allowedFeeds.has(name)) return;

    const existing = this.feeds.get(name) || { name, lastUpdate: null, status: 'ok' as const, itemCount: 0 };
    this.feeds.set(name, { ...existing, ...status, lastUpdate: new Date() });
    this.updateStatusIcon();
    if (this.isOpen) this.updateDisplay();
  }

  public updateApi(name: string, status: Partial<ApiStatus>): void {
    // Only track APIs relevant to current variant
    if (!this.allowedApis.has(name)) return;

    const existing = this.apis.get(name) || { name, status: 'ok' as const };
    this.apis.set(name, { ...existing, ...status });
    this.updateStatusIcon();
    if (this.isOpen) this.updateDisplay();
  }

  public setFeedDisabled(name: string): void {
    const existing = this.feeds.get(name);
    if (existing) {
      this.feeds.set(name, { ...existing, status: 'disabled', itemCount: 0, lastUpdate: null });
      this.updateStatusIcon();
      if (this.isOpen) this.updateDisplay();
    }
  }

  public setApiDisabled(name: string): void {
    const existing = this.apis.get(name);
    if (existing) {
      this.apis.set(name, { ...existing, status: 'disabled' });
      this.updateStatusIcon();
      if (this.isOpen) this.updateDisplay();
    }
  }

  private updateStatusIcon(): void {
    const icon = this.element.querySelector('.status-icon')!;
    // Only count enabled feeds/APIs (not 'disabled') for status indicator
    const enabledFeeds = [...this.feeds.values()].filter(f => f.status !== 'disabled');
    const enabledApis = [...this.apis.values()].filter(a => a.status !== 'disabled');

    const hasError = enabledFeeds.some(f => f.status === 'error') ||
      enabledApis.some(a => a.status === 'error');
    const hasWarning = enabledFeeds.some(f => f.status === 'warning') ||
      enabledApis.some(a => a.status === 'warning');

    icon.className = 'status-icon';
    if (hasError) {
      icon.classList.add('error');
      icon.textContent = '◉';
    } else if (hasWarning) {
      icon.classList.add('warning');
      icon.textContent = '◉';
    } else {
      icon.classList.add('ok');
      icon.textContent = '◉';
    }
  }

  private updateDisplay(): void {
    const feedsList = this.element.querySelector('.feeds-list')!;
    const apisList = this.element.querySelector('.apis-list')!;
    const storageInfo = this.element.querySelector('.storage-info')!;
    const lastCheck = this.element.querySelector('.last-check')!;

    replaceChildren(feedsList,
      ...[...this.feeds.values()].map(feed =>
        h('div', { className: 'status-row' },
          h('span', { className: `status-dot ${feed.status}` }),
          h('span', { className: 'status-name' }, feed.name),
          h('span', { className: 'status-detail' }, `${feed.itemCount} items`),
          h('span', { className: 'status-time' }, feed.lastUpdate ? this.formatTime(feed.lastUpdate) : 'Never'),
        ),
      ),
    );

    replaceChildren(apisList,
      ...[...this.apis.values()].map(api =>
        h('div', { className: 'status-row' },
          h('span', { className: `status-dot ${api.status}` }),
          h('span', { className: 'status-name' }, api.name),
          api.latency ? h('span', { className: 'status-detail' }, `${api.latency}ms`) : false,
        ),
      ),
    );

    this.updateStorageInfo(storageInfo);
    lastCheck.textContent = t('components.status.updatedAt', { time: this.formatTime(new Date()) });
  }

  private async updateStorageInfo(container: Element): Promise<void> {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(2) : '0';
        const quota = estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'N/A';
        replaceChildren(container,
          h('div', { className: 'status-row' },
            h('span', { className: 'status-name' }, 'IndexedDB'),
            h('span', { className: 'status-detail' }, `${used} MB / ${quota} MB`),
          ),
        );
      } else {
        replaceChildren(container, h('div', { className: 'status-row' }, t('components.status.storageUnavailable')));
      }
    } catch {
      replaceChildren(container, h('div', { className: 'status-row' }, t('components.status.storageUnavailable')));
    }
  }

  private formatTime(date: Date): string {
    return date.toLocaleString();
  }

  private parseStoredValue(raw: string | null): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  private readDebugLocalStorage(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of DEBUG_LOCAL_STORAGE_KEYS) {
      out[key] = this.parseStoredValue(localStorage.getItem(key));
    }
    return out;
  }

  private async getStorageEstimateForDebug(): Promise<{ usageBytes: number | null; quotaBytes: number | null }> {
    try {
      if (!('storage' in navigator) || !('estimate' in navigator.storage)) {
        return { usageBytes: null, quotaBytes: null };
      }
      const estimate = await navigator.storage.estimate();
      return {
        usageBytes: typeof estimate.usage === 'number' ? estimate.usage : null,
        quotaBytes: typeof estimate.quota === 'number' ? estimate.quota : null,
      };
    } catch {
      return { usageBytes: null, quotaBytes: null };
    }
  }

  private async buildDebugReport(): Promise<Record<string, unknown>> {
    const feeds = [...this.feeds.values()].map((feed) => ({
      ...feed,
      lastUpdate: feed.lastUpdate ? feed.lastUpdate.toISOString() : null,
    }));
    const apis = [...this.apis.values()];
    const storageEstimate = await this.getStorageEstimateForDebug();

    return {
      exportedAt: new Date().toISOString(),
      variant: SITE_VARIANT,
      page: {
        href: window.location.href,
        origin: window.location.origin,
        pathname: window.location.pathname,
      },
      browser: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        online: navigator.onLine,
      },
      storage: storageEstimate,
      status: {
        feeds,
        apis,
      },
      localStorage: this.readDebugLocalStorage(),
    };
  }

  private async exportDebugReport(): Promise<void> {
    const exportedAt = new Date();
    try {
      const payload = await this.buildDebugReport();
      const fileTime = exportedAt.toISOString().replace(/[:.]/g, '-');
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `worldmonitor-debug-${fileTime}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      const lastCheck = this.element.querySelector('.last-check');
      if (lastCheck) {
        lastCheck.textContent = `${t('components.status.updatedAt', { time: this.formatTime(new Date()) })} · Debug report exported`;
      }
    } catch (error) {
      console.error('[StatusPanel] Failed to export debug report', error);
      const lastCheck = this.element.querySelector('.last-check');
      if (lastCheck) {
        lastCheck.textContent = `${t('components.status.updatedAt', { time: this.formatTime(new Date()) })} · Export failed`;
      }
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
