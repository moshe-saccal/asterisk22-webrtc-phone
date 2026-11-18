import { formatDuration, formatRelativeTime } from '../util/format';
import { avatar } from './avatar';
import type { DialHandler } from './contacts';
import { clear, h } from './dom';
import type { CallHistory, HistoryEntry } from './history';
import { icon } from './icons';

const OUTCOME_TEXT: Record<HistoryEntry['outcome'], string> = {
  answered: '',
  missed: 'Missed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  failed: 'Not answered',
};

export class RecentsPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;

  constructor(
    private readonly history: CallHistory,
    private readonly onDial: DialHandler,
  ) {
    this.list = h('div', { class: 'list', role: 'list' });
    this.el = h(
      'div',
      { class: 'panel-body' },
      h(
        'div',
        { class: 'panel-toolbar' },
        h('span', { class: 'muted' }, 'Call history'),
        h(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            onclick: () => {
              this.history.clear();
              this.render();
            },
          },
          'Clear',
        ),
      ),
      this.list,
    );
    this.render();
  }

  render(): void {
    clear(this.list);
    const entries = this.history.all;
    if (!entries.length) {
      this.list.append(h('div', { class: 'empty' }, icon('clock', 28), h('p', {}, 'No calls yet.')));
      return;
    }
    for (const entry of entries) this.list.append(this.row(entry));
  }

  private row(entry: HistoryEntry): HTMLElement {
    const missed = entry.outcome === 'missed';
    const directionIcon = missed ? 'phone-missed' : entry.direction === 'incoming' ? 'phone-incoming' : 'phone-outgoing';
    const detail = entry.outcome === 'answered' ? formatDuration(entry.durationSeconds) : OUTCOME_TEXT[entry.outcome];
    return h(
      'div',
      { class: `list-item recent${missed ? ' missed' : ''}`, role: 'listitem' },
      avatar(entry.name, entry.number, 'sm'),
      h(
        'div',
        { class: 'list-text' },
        h('div', { class: 'list-title' }, entry.name, entry.name !== entry.number ? h('span', { class: 'muted small' }, ` ${entry.number}`) : null),
        h(
          'div',
          { class: 'list-subtitle' },
          h('span', { class: 'recent-direction' }, icon(directionIcon, 14)),
          entry.video ? h('span', { class: 'recent-video', title: 'Video call' }, icon('video', 14)) : null,
          h('span', {}, `${formatRelativeTime(entry.startedAt)} · ${detail}`),
        ),
      ),
      h(
        'div',
        { class: 'list-actions' },
        h('button', { class: 'icon-btn', 'aria-label': `Call ${entry.name}`, title: 'Call back', onclick: () => this.onDial(entry.number, entry.name, false) }, icon('phone', 18)),
        h('button', { class: 'icon-btn', 'aria-label': `Video call ${entry.name}`, title: 'Video call', onclick: () => this.onDial(entry.number, entry.name, true) }, icon('video', 18)),
      ),
    );
  }
}
