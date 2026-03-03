import { Panel } from './Panel';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { generateSummary } from '@/services/summarization';
import { t, getCurrentLanguage } from '@/services/i18n';
import { h, replaceChildren } from '@/utils/dom-utils';
import {
  TELEGRAM_TOPICS,
  formatTelegramTime,
  type TelegramItem,
  type TelegramFeedResponse,
} from '@/services/telegram-intel';

export class TelegramIntelPanel extends Panel {
  private items: TelegramItem[] = [];
  private activeTopic = 'all';
  private tabsEl: HTMLElement | null = null;
  private relayEnabled = true;
  private summaryBtn: HTMLButtonElement | null = null;
  private summaryContainer: HTMLElement | null = null;
  private isSummarizing = false;

  constructor() {
    super({
      id: 'telegram-intel',
      title: t('panels.telegramIntel'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.telegramIntel.infoTooltip'),
    });
    this.element.classList.add('panel-default-span-2');
    this.createTabs();
    this.createSummarizeButton();
    this.showLoading(t('components.telegramIntel.loading'));
  }

  private createTabs(): void {
    this.tabsEl = h('div', { className: 'telegram-intel-tabs' },
      ...TELEGRAM_TOPICS.map(topic =>
        h('button', {
          className: `telegram-intel-tab ${topic.id === this.activeTopic ? 'active' : ''}`,
          dataset: { topicId: topic.id },
          onClick: () => this.selectTopic(topic.id),
        }, t(topic.labelKey)),
      ),
    );
    this.element.insertBefore(this.tabsEl, this.content);
  }

  private selectTopic(topicId: string): void {
    if (topicId === this.activeTopic) return;
    this.activeTopic = topicId;
    this.hideSummary();

    this.tabsEl?.querySelectorAll('.telegram-intel-tab').forEach(tab => {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.topicId === topicId);
    });

    this.renderItems();
  }

  private createSummarizeButton(): void {
    this.summaryContainer = document.createElement('div');
    this.summaryContainer.className = 'panel-summary';
    this.summaryContainer.style.display = 'none';
    this.element.insertBefore(this.summaryContainer, this.content);

    this.summaryBtn = document.createElement('button');
    this.summaryBtn.className = 'panel-summarize-btn';
    this.summaryBtn.innerHTML = '✨';
    this.summaryBtn.title = t('components.newsPanel.summarize');
    this.summaryBtn.addEventListener('click', () => void this.handleSummarize());

    const countEl = this.header.querySelector('.panel-count');
    if (countEl) {
      this.header.insertBefore(this.summaryBtn, countEl);
    } else {
      this.header.appendChild(this.summaryBtn);
    }
  }

  private getFilteredItems(): TelegramItem[] {
    return this.activeTopic === 'all'
      ? this.items
      : this.items.filter(item => item.topic === this.activeTopic);
  }

  private updateSummaryButtonState(filtered: TelegramItem[]): void {
    if (!this.summaryBtn) return;
    const canSummarize = this.relayEnabled && filtered.length >= 2;
    this.summaryBtn.disabled = !canSummarize || this.isSummarizing;
    this.summaryBtn.style.display = this.relayEnabled ? '' : 'none';
  }

  private async handleSummarize(): Promise<void> {
    if (!this.summaryBtn || !this.summaryContainer || this.isSummarizing) return;

    const filtered = this.getFilteredItems();
    if (filtered.length < 2) return;

    this.isSummarizing = true;
    this.summaryBtn.innerHTML = '<span class="panel-summarize-spinner"></span>';
    this.summaryBtn.disabled = true;
    this.summaryContainer.style.display = 'block';
    this.summaryContainer.innerHTML = `<div class="panel-summary-loading">${t('components.newsPanel.generatingSummary')}</div>`;

    try {
      const headlines = filtered
        .slice(0, 12)
        .map((item) => `${item.channelTitle || item.channel}: ${item.text}`.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const summary = await generateSummary(
        headlines,
        undefined,
        `Telegram OSINT feed (${this.activeTopic})`,
        getCurrentLanguage(),
      );

      if (summary?.summary) {
        this.showSummary(summary.summary);
      } else {
        this.summaryContainer.innerHTML = '<div class="panel-summary-error">Summary failed</div>';
        setTimeout(() => this.hideSummary(), 3000);
      }
    } catch {
      this.summaryContainer.innerHTML = '<div class="panel-summary-error">Summary failed</div>';
      setTimeout(() => this.hideSummary(), 3000);
    } finally {
      this.isSummarizing = false;
      if (this.summaryBtn) {
        this.summaryBtn.innerHTML = '✨';
      }
      this.updateSummaryButtonState(this.getFilteredItems());
    }
  }

  private showSummary(summary: string): void {
    if (!this.summaryContainer) return;
    this.summaryContainer.style.display = 'block';
    this.summaryContainer.innerHTML = `
      <div class="panel-summary-content">
        <span class="panel-summary-text">${escapeHtml(summary)}</span>
        <button class="panel-summary-close" title="${t('components.newsPanel.close')}">×</button>
      </div>
    `;
    this.summaryContainer.querySelector('.panel-summary-close')?.addEventListener('click', () => this.hideSummary());
  }

  private hideSummary(): void {
    if (!this.summaryContainer) return;
    this.summaryContainer.style.display = 'none';
    this.summaryContainer.innerHTML = '';
  }

  public setData(response: TelegramFeedResponse): void {
    this.relayEnabled = response.enabled;
    this.items = response.items || [];

    if (!this.relayEnabled) {
      this.setCount(0);
      this.updateSummaryButtonState([]);
      this.hideSummary();
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.disabled')),
      );
      return;
    }

    this.renderItems();
  }

  private renderItems(): void {
    const filtered = this.getFilteredItems();

    this.setCount(filtered.length);
    this.updateSummaryButtonState(filtered);

    if (filtered.length === 0) {
      this.hideSummary();
      replaceChildren(this.content,
        h('div', { className: 'empty-state' }, t('components.telegramIntel.empty')),
      );
      return;
    }

    replaceChildren(this.content,
      h('div', { className: 'telegram-intel-items' },
        ...filtered.map(item => this.buildItem(item)),
      ),
    );
  }

  private buildItem(item: TelegramItem): HTMLElement {
    const timeAgo = formatTelegramTime(item.ts);

    return h('a', {
      href: sanitizeUrl(item.url),
      target: '_blank',
      rel: 'noopener noreferrer',
      className: 'telegram-intel-item',
    },
      h('div', { className: 'telegram-intel-item-header' },
        h('span', { className: 'telegram-intel-channel' }, item.channelTitle || item.channel),
        h('span', { className: 'telegram-intel-topic' }, item.topic),
        h('span', { className: 'telegram-intel-time' }, timeAgo),
      ),
      h('div', { className: 'telegram-intel-text' }, item.text),
    );
  }

  public async refresh(): Promise<void> {
    // Handled by DataLoader + RefreshScheduler
  }

  public destroy(): void {
    if (this.tabsEl) {
      this.tabsEl.remove();
      this.tabsEl = null;
    }
    if (this.summaryContainer) {
      this.summaryContainer.remove();
      this.summaryContainer = null;
    }
    super.destroy();
  }
}
