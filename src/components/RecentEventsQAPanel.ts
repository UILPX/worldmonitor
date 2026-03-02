import { Panel } from './Panel';
import { SITE_VARIANT } from '@/config';
import { t } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';

interface RecentEventsQAResponse {
  question: string;
  answer: string;
  provider: string;
  model: string;
  generatedAt: number;
  cached: boolean;
  headlineCount: number;
  contextChars: number;
  windowStartMs: number;
  windowEndMs: number;
}

interface RecentEventsQAError {
  error?: string;
  reason?: string;
  details?: string;
  retryAfterSec?: number;
}

export class RecentEventsQAPanel extends Panel {
  private question = '';
  private answer: RecentEventsQAResponse | null = null;
  private errorMessage = '';
  private isLoading = false;

  constructor() {
    super({
      id: 'recent-events-qa',
      title: t('panels.recentEventsQa'),
      showCount: false,
      infoTooltip: t('components.recentEventsQa.infoTooltip'),
    });
    this.element.classList.add('panel-default-span-2');
    this.setDataBadge('cached', t('components.recentEventsQa.ready'));
    this.render();
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

  private render(): void {
    const textarea = document.createElement('textarea');
    textarea.className = 'recent-events-qa-input';
    textarea.placeholder = t('components.recentEventsQa.placeholder');
    textarea.value = this.question;
    textarea.maxLength = 240;
    textarea.rows = 3;
    textarea.disabled = this.isLoading;
    textarea.addEventListener('input', () => {
      this.question = textarea.value;
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.submitQuestion();
      }
    });

    const askBtn = h('button', {
      type: 'button',
      className: 'recent-events-qa-submit',
      disabled: this.isLoading || this.question.trim().length < 3,
      onClick: () => void this.submitQuestion(),
    }, this.isLoading ? t('components.recentEventsQa.asking') : t('components.recentEventsQa.ask'));

    const controls = h('div', { className: 'recent-events-qa-controls' }, textarea, askBtn);
    const hints = h(
      'div',
      { className: 'recent-events-qa-hints' },
      t('components.recentEventsQa.hintCache'),
      ' · ',
      t('components.recentEventsQa.hintRateLimit'),
    );

    const body: HTMLElement[] = [controls, hints];

    if (this.errorMessage) {
      body.push(h('div', { className: 'recent-events-qa-error' }, this.errorMessage));
    }

    if (this.answer) {
      body.push(
        h('div', { className: 'recent-events-qa-answer' },
          h('div', { className: 'recent-events-qa-answer-text' }, this.answer.answer),
          h(
            'div',
            { className: 'recent-events-qa-meta' },
            `${t('components.recentEventsQa.updated')}: ${this.formatLocal(this.answer.generatedAt)}`,
            ' · ',
            `${t('components.recentEventsQa.window')}: ${this.formatLocal(this.answer.windowStartMs)} → ${this.formatLocal(this.answer.windowEndMs)}`,
          ),
          h(
            'div',
            { className: 'recent-events-qa-meta' },
            `${t('components.recentEventsQa.headlines')}: ${this.answer.headlineCount}`,
            ' · ',
            `${t('components.recentEventsQa.contextChars')}: ${this.answer.contextChars}`,
            this.answer.provider ? ` · ${t('components.recentEventsQa.provider')}: ${this.answer.provider}${this.answer.model ? `/${this.answer.model}` : ''}` : '',
          ),
        ),
      );
    } else if (!this.errorMessage) {
      body.push(h('div', { className: 'recent-events-qa-empty' }, t('components.recentEventsQa.empty')));
    }

    replaceChildren(this.content, h('div', { className: 'recent-events-qa' }, ...body));
  }

  private async submitQuestion(): Promise<void> {
    if (this.isLoading) return;

    const question = this.question.trim();
    if (question.length < 3) {
      this.errorMessage = t('components.recentEventsQa.minQuestion');
      this.setDataBadge('unavailable');
      this.render();
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';
    this.render();

    try {
      const resp = await fetch(`/api/recent-events-qa?variant=${encodeURIComponent(SITE_VARIANT)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, variant: SITE_VARIANT }),
        signal: AbortSignal.timeout(35_000),
      });

      if (!resp.ok) {
        const errorPayload = await resp.json().catch(() => ({})) as RecentEventsQAError;
        if (resp.status === 429) {
          const retryAfter = errorPayload.retryAfterSec || Number(resp.headers.get('Retry-After') || '0');
          this.errorMessage = t('components.recentEventsQa.rateLimited', { seconds: String(Math.max(1, retryAfter || 10)) });
        } else if (resp.status === 503) {
          this.errorMessage = t('components.recentEventsQa.noProvider');
        } else {
          this.errorMessage = errorPayload.error || t('components.recentEventsQa.failed');
        }
        this.setDataBadge('unavailable');
        return;
      }

      const data = await resp.json() as RecentEventsQAResponse;
      this.answer = data;
      this.errorMessage = '';
      const detail = data.provider ? `${data.provider}${data.model ? `/${data.model}` : ''}` : undefined;
      this.setDataBadge(data.cached ? 'cached' : 'live', detail);
    } catch {
      this.errorMessage = t('components.recentEventsQa.failed');
      this.setDataBadge('unavailable');
    } finally {
      this.isLoading = false;
      this.render();
    }
  }
}
