
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { getLocalApiPort, isDesktopRuntime } from '@/services/runtime';
import {
  getDesktopReadinessChecks,
  getKeyBackedAvailabilitySummary,
  getNonParityFeatures,
} from '@/services/desktop-readiness';
import {
  fetchServiceStatuses,
  type ServiceStatusResult as ServiceStatus,
} from '@/services/infrastructure';
import { h, replaceChildren, type DomChild } from '@/utils/dom-utils';

interface LocalBackendStatus {
  enabled?: boolean;
  mode?: string;
  port?: number;
  remoteBase?: string;
}

interface LocalLlmQueueTask {
  scope: string;
  priority: number;
  seq: number;
  enqueuedAt: number;
  startedAt: number | null;
  waitMs: number;
  runMs: number;
}

interface LocalLlmQueueState {
  ok: boolean;
  stats: { active: number; pending: number };
  active: LocalLlmQueueTask[];
  pending: LocalLlmQueueTask[];
  updatedAt: number;
}

type CategoryFilter = 'all' | 'cloud' | 'dev' | 'comm' | 'ai' | 'saas';

function getCategoryLabel(category: CategoryFilter): string {
  const labels: Record<CategoryFilter, string> = {
    all: t('components.serviceStatus.categories.all'),
    cloud: t('components.serviceStatus.categories.cloud'),
    dev: t('components.serviceStatus.categories.dev'),
    comm: t('components.serviceStatus.categories.comm'),
    ai: t('components.serviceStatus.categories.ai'),
    saas: t('components.serviceStatus.categories.saas'),
  };
  return labels[category];
}

export class ServiceStatusPanel extends Panel {
  private services: ServiceStatus[] = [];
  private loading = true;
  private error: string | null = null;
  private filter: CategoryFilter = 'all';
  private localBackend: LocalBackendStatus | null = null;
  private localLlmQueue: LocalLlmQueueState | null = null;
  private localLlmQueueError: string | null = null;
  private localLlmQueuePollTimer: ReturnType<typeof setInterval> | null = null;
  private lastQueueFingerprint = '';

  constructor() {
    super({ id: 'service-status', title: t('panels.serviceStatus'), showCount: false });
    void this.fetchStatus();
    void this.fetchLocalLlmQueueStatus();
    this.startLocalLlmQueuePolling();
  }

  private lastServicesJson = '';

  public async fetchStatus(): Promise<boolean> {
    try {
      const data = await fetchServiceStatuses();
      if (!data.success) throw new Error('Failed to load status');

      const fingerprint = data.services.map(s => `${s.name}:${s.status}`).join(',');
      const changed = fingerprint !== this.lastServicesJson;
      this.lastServicesJson = fingerprint;
      this.services = data.services;
      this.error = null;
      return changed;
    } catch (err) {
      if (this.isAbortError(err)) return false;
      this.error = err instanceof Error ? err.message : 'Failed to fetch';
      console.error('[ServiceStatus] Fetch error:', err);
      return true;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private setFilter(filter: CategoryFilter): void {
    this.filter = filter;
    this.render();
  }

  private getFilteredServices(): ServiceStatus[] {
    if (this.filter === 'all') return this.services;
    return this.services.filter(s => s.category === this.filter);
  }

  protected render(): void {
    if (this.loading) {
      replaceChildren(this.content,
        h('div', { className: 'service-status-loading' },
          h('div', { className: 'loading-spinner' }),
          h('span', null, t('components.serviceStatus.checkingServices')),
        ),
      );
      return;
    }

    if (this.error) {
      replaceChildren(this.content,
        h('div', { className: 'service-status-error' },
          h('span', { className: 'error-text' }, this.error),
          h('button', {
            className: 'retry-btn',
            onClick: () => { this.loading = true; this.render(); void this.fetchStatus(); },
          }, t('common.retry')),
        ),
      );
      return;
    }

    const filtered = this.getFilteredServices();
    const issues = filtered.filter(s => s.status !== 'operational');

    replaceChildren(this.content,
      this.buildBackendStatus(),
      this.buildLocalLlmQueueStatus(),
      this.buildDesktopReadiness(),
      this.buildSummary(filtered),
      this.buildFilters(),
      h('div', { className: 'service-status-list' },
        ...this.buildServiceItems(filtered),
      ),
      issues.length === 0 ? h('div', { className: 'all-operational' }, t('components.serviceStatus.allOperational')) : false,
    );
  }

  private buildBackendStatus(): DomChild {
    if (!isDesktopRuntime()) return false;

    if (!this.localBackend?.enabled) {
      return h('div', { className: 'service-status-backend warning' },
        t('components.serviceStatus.backendUnavailable'),
      );
    }

    const port = this.localBackend.port ?? getLocalApiPort();
    const remote = this.localBackend.remoteBase ?? 'https://worldmonitor.app';

    return h('div', { className: 'service-status-backend' },
      'Local backend active on ', h('strong', null, `127.0.0.1:${port}`),
      ' · cloud fallback: ', h('strong', null, remote),
    );
  }

  private buildSummary(services: ServiceStatus[]): HTMLElement {
    const operational = services.filter(s => s.status === 'operational').length;
    const degraded = services.filter(s => s.status === 'degraded').length;
    const outage = services.filter(s => s.status === 'outage').length;

    return h('div', { className: 'service-status-summary' },
      h('div', { className: 'summary-item operational' },
        h('span', { className: 'summary-count' }, String(operational)),
        h('span', { className: 'summary-label' }, t('components.serviceStatus.ok')),
      ),
      h('div', { className: 'summary-item degraded' },
        h('span', { className: 'summary-count' }, String(degraded)),
        h('span', { className: 'summary-label' }, t('components.serviceStatus.degraded')),
      ),
      h('div', { className: 'summary-item outage' },
        h('span', { className: 'summary-count' }, String(outage)),
        h('span', { className: 'summary-label' }, t('components.serviceStatus.outage')),
      ),
    );
  }

  private buildDesktopReadiness(): DomChild {
    if (!isDesktopRuntime()) return false;

    const checks = getDesktopReadinessChecks(Boolean(this.localBackend?.enabled));
    const keySummary = getKeyBackedAvailabilitySummary();
    const nonParity = getNonParityFeatures();

    return h('div', { className: 'service-status-desktop-readiness' },
      h('div', { className: 'service-status-desktop-title' }, t('components.serviceStatus.desktopReadiness')),
      h('div', { className: 'service-status-desktop-subtitle' },
        t('components.serviceStatus.acceptanceChecks', { ready: String(checks.filter(check => check.ready).length), total: String(checks.length), available: String(keySummary.available), featureTotal: String(keySummary.total) }),
      ),
      h('ul', { className: 'service-status-desktop-list' },
        ...checks.map(check =>
          h('li', null, `${check.ready ? '✅' : '⚠️'} ${check.label}`),
        ),
      ),
      h('details', { className: 'service-status-non-parity' },
        h('summary', null, t('components.serviceStatus.nonParityFallbacks', { count: String(nonParity.length) })),
        h('ul', null,
          ...nonParity.map(feature =>
            h('li', null, h('strong', null, feature.panel), `: ${feature.fallback}`),
          ),
        ),
      ),
    );
  }

  private startLocalLlmQueuePolling(): void {
    if (this.localLlmQueuePollTimer) return;
    this.localLlmQueuePollTimer = setInterval(() => {
      void this.fetchLocalLlmQueueStatus();
    }, 3000);
  }

  private async fetchLocalLlmQueueStatus(): Promise<void> {
    try {
      const resp = await fetch('/api/local-llm-queue', {
        cache: 'no-store',
        signal: this.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const payload = (await resp.json()) as LocalLlmQueueState;
      const fingerprint = JSON.stringify({
        a: payload.stats.active,
        p: payload.stats.pending,
        active: payload.active.map((task) => `${task.seq}:${task.scope}:${task.runMs}`).join('|'),
        pending: payload.pending.map((task) => `${task.seq}:${task.scope}:${task.waitMs}`).join('|'),
      });

      const changed = fingerprint !== this.lastQueueFingerprint || this.localLlmQueueError !== null;
      this.lastQueueFingerprint = fingerprint;
      this.localLlmQueue = payload;
      this.localLlmQueueError = null;
      if (changed) this.render();
    } catch (error) {
      if (this.isAbortError(error)) return;
      const message = error instanceof Error ? error.message : 'Queue status fetch failed';
      if (this.localLlmQueueError !== message) {
        this.localLlmQueueError = message;
        this.render();
      }
    }
  }

  private formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  private buildTaskRows(tasks: LocalLlmQueueTask[], active: boolean): DomChild[] {
    return tasks.map((task) =>
      h('li', { className: 'service-status-llm-queue-item' },
        h('span', { className: 'scope' }, task.scope),
        h('span', { className: 'meta' },
          active
            ? `wait ${this.formatDuration(task.waitMs)} · run ${this.formatDuration(task.runMs)}`
            : `queued ${this.formatDuration(Date.now() - task.enqueuedAt)} · wait ${this.formatDuration(task.waitMs)}`,
        ),
      ),
    );
  }

  private buildLocalLlmQueueStatus(): DomChild {
    const queue = this.localLlmQueue;
    const activeTasks = queue?.active ?? [];
    const pendingTasks = queue?.pending ?? [];
    const activeCount = queue?.stats.active ?? activeTasks.length;
    const pendingCount = queue?.stats.pending ?? pendingTasks.length;
    const summaryText = `Local LLM Queue (${pendingCount} queued, ${activeCount} running)`;

    return h('details', { className: 'service-status-llm-queue' },
      h('summary', null, summaryText),
      h('div', { className: 'service-status-llm-queue-meta' },
        queue?.updatedAt
          ? `Updated ${new Date(queue.updatedAt).toLocaleTimeString()}`
          : 'Waiting for queue status...',
      ),
      this.localLlmQueueError
        ? h('div', { className: 'service-status-llm-queue-error' }, this.localLlmQueueError)
        : false,
      h('div', { className: 'service-status-llm-queue-group' },
        h('div', { className: 'service-status-llm-queue-title' }, 'Running'),
        activeTasks.length > 0
          ? h('ul', { className: 'service-status-llm-queue-list' }, ...this.buildTaskRows(activeTasks, true))
          : h('div', { className: 'service-status-llm-queue-empty' }, 'No running tasks'),
      ),
      h('div', { className: 'service-status-llm-queue-group' },
        h('div', { className: 'service-status-llm-queue-title' }, 'Queued'),
        pendingTasks.length > 0
          ? h('ul', { className: 'service-status-llm-queue-list' }, ...this.buildTaskRows(pendingTasks, false))
          : h('div', { className: 'service-status-llm-queue-empty' }, 'No queued tasks'),
      ),
    );
  }

  private buildFilters(): HTMLElement {
    const categories: CategoryFilter[] = ['all', 'cloud', 'dev', 'comm', 'ai', 'saas'];
    return h('div', { className: 'service-status-filters' },
      ...categories.map(key =>
        h('button', {
          className: `status-filter-btn ${this.filter === key ? 'active' : ''}`,
          dataset: { filter: key },
          onClick: () => this.setFilter(key),
        }, getCategoryLabel(key)),
      ),
    );
  }

  private buildServiceItems(services: ServiceStatus[]): HTMLElement[] {
    return services.map(service =>
      h('div', { className: `service-status-item ${service.status}` },
        h('span', { className: 'status-icon' }, this.getStatusIcon(service.status)),
        h('span', { className: 'status-name' }, service.name),
        h('span', { className: `status-badge ${service.status}` }, service.status.toUpperCase()),
      ),
    );
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'operational': return '●';
      case 'degraded': return '◐';
      case 'outage': return '○';
      default: return '?';
    }
  }

  public override destroy(): void {
    if (this.localLlmQueuePollTimer) {
      clearInterval(this.localLlmQueuePollTimer);
      this.localLlmQueuePollTimer = null;
    }
    super.destroy();
  }

}
