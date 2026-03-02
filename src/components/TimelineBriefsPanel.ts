import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { SITE_VARIANT } from '@/config';
import { t } from '@/services/i18n';

type BriefPeriod = '10m' | '1h' | '12h';

interface TimelineBrief {
  period: BriefPeriod;
  slotKey: string;
  startMs: number;
  endMs: number;
  generatedAt: number;
  summary: string;
  headlineCount: number;
  provider: string;
  model: string;
}

interface TimelineBriefsPayload {
  generatedAt: number;
  variant: string;
  briefs?: {
    tenMinutes?: TimelineBrief;
    oneHour?: TimelineBrief;
    twelveHours?: TimelineBrief;
  };
}

export class TimelineBriefsPanel extends Panel {
  private refreshTenMinutesBtn: HTMLButtonElement | null = null;
  private isForceRefreshing = false;
  private latestBriefs: NonNullable<TimelineBriefsPayload['briefs']> | null = null;

  constructor() {
    super({
      id: 'timeline-briefs',
      title: t('panels.timelineBriefs'),
      showCount: false,
    });
    this.element.classList.add('panel-default-span-2');
    this.createRefreshTenMinutesButton();
  }

  private createRefreshTenMinutesButton(): void {
    this.refreshTenMinutesBtn = document.createElement('button');
    this.refreshTenMinutesBtn.className = 'panel-summarize-btn';
    this.refreshTenMinutesBtn.title = t('components.timelineBriefs.refreshTenMinutes') || 'Refresh 10-minute brief now';
    this.refreshTenMinutesBtn.addEventListener('click', () => void this.handleForceRefreshTenMinutes());
    this.header.appendChild(this.refreshTenMinutesBtn);
    this.updateRefreshButtonState();
  }

  private updateRefreshButtonState(): void {
    if (!this.refreshTenMinutesBtn) return;
    this.refreshTenMinutesBtn.disabled = this.isForceRefreshing;
    this.refreshTenMinutesBtn.textContent = this.isForceRefreshing
      ? (t('common.loading') || 'Loading...')
      : (t('components.timelineBriefs.refreshTenMinutesShort') || '10m↻');
  }

  private async handleForceRefreshTenMinutes(): Promise<void> {
    if (this.isForceRefreshing) return;
    this.isForceRefreshing = true;
    this.updateRefreshButtonState();
    try {
      await this.fetchData({ forceTenMinutes: true });
    } finally {
      this.isForceRefreshing = false;
      this.updateRefreshButtonState();
    }
  }

  async fetchData(options: { forceTenMinutes?: boolean } = {}): Promise<void> {
    const forceTenMinutes = options.forceTenMinutes === true;
    if (!forceTenMinutes || !this.latestBriefs) {
      this.showLoading();
    }
    try {
      const params = new URLSearchParams({ variant: SITE_VARIANT });
      if (forceTenMinutes) {
        params.set('forceTenMinutes', '1');
        params.set('only', '10m');
        params.set('_ts', String(Date.now()));
      }
      const resp = await fetch(`/api/timeline-briefs?${params.toString()}`, {
        cache: forceTenMinutes ? 'no-store' : 'default',
        signal: AbortSignal.timeout(25_000),
      });
      if (!resp.ok) {
        let detail = '';
        try {
          const payload = await resp.json() as { details?: string; error?: string };
          detail = payload.details || payload.error || '';
        } catch {
          // ignore parse errors and use status only
        }
        throw new Error(detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`);
      }

      const data = await resp.json() as TimelineBriefsPayload;
      const briefs = data.briefs;
      if (!briefs) {
        this.setDataBadge('unavailable');
        if (!this.latestBriefs) {
          this.showError(t('components.timelineBriefs.unavailable'));
        }
        return;
      }

      const merged: NonNullable<TimelineBriefsPayload['briefs']> = {
        tenMinutes: briefs.tenMinutes ?? this.latestBriefs?.tenMinutes,
        oneHour: briefs.oneHour ?? this.latestBriefs?.oneHour,
        twelveHours: briefs.twelveHours ?? this.latestBriefs?.twelveHours,
      };
      this.latestBriefs = merged;
      this.setDataBadge('live');
      this.setContent(this.renderBriefs(merged));
    } catch (error) {
      console.error('[TimelineBriefsPanel] fetchData failed:', error);
      this.setDataBadge('unavailable');
      if (!this.latestBriefs) {
        this.showError(t('components.timelineBriefs.unavailable'));
      }
    }
  }

  private formatLocal(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  private renderCard(brief: TimelineBrief | undefined, title: string, scheduleLabel: string): string {
    if (!brief) {
      return `
        <div class="timeline-brief-card">
          <div class="timeline-brief-card-header">
            <span class="timeline-brief-title">${escapeHtml(title)}</span>
            <span class="timeline-brief-schedule">${escapeHtml(scheduleLabel)}</span>
          </div>
          <div class="timeline-brief-summary">${escapeHtml(t('components.timelineBriefs.unavailable'))}</div>
        </div>
      `;
    }

    return `
      <div class="timeline-brief-card">
        <div class="timeline-brief-card-header">
          <span class="timeline-brief-title">${escapeHtml(title)}</span>
          <span class="timeline-brief-schedule">${escapeHtml(scheduleLabel)}</span>
        </div>
        <div class="timeline-brief-window">
          ${escapeHtml(t('components.timelineBriefs.window'))}: ${escapeHtml(this.formatLocal(brief.startMs))} → ${escapeHtml(this.formatLocal(brief.endMs))}
        </div>
        <div class="timeline-brief-summary">${escapeHtml(brief.summary)}</div>
        <div class="timeline-brief-meta">
          ${escapeHtml(t('components.timelineBriefs.updated'))}: ${escapeHtml(this.formatLocal(brief.generatedAt))}
          <span class="timeline-brief-sep">•</span>
          ${escapeHtml(t('components.timelineBriefs.headlines'))}: ${brief.headlineCount}
        </div>
      </div>
    `;
  }

  private renderBriefs(briefs: NonNullable<TimelineBriefsPayload['briefs']>): string {
    return `
      <div class="timeline-briefs">
        ${this.renderCard(briefs.tenMinutes, t('components.timelineBriefs.tenMinutes'), t('components.timelineBriefs.everyTenMinutes'))}
        ${this.renderCard(briefs.oneHour, t('components.timelineBriefs.oneHour'), t('components.timelineBriefs.everyHour'))}
        ${this.renderCard(briefs.twelveHours, t('components.timelineBriefs.twelveHours'), t('components.timelineBriefs.nyTwiceDaily'))}
      </div>
    `;
  }
}
