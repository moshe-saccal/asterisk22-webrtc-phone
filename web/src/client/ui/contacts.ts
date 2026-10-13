import type { DirectoryEntry, ServiceEntry } from '../config';
import type { PresenceState } from '../sip/presence';
import { avatar } from './avatar';
import { clear, h } from './dom';
import { icon } from './icons';

export type DialHandler = (number: string, name: string, video: boolean) => void;

const PRESENCE_LABEL: Record<PresenceState, string> = {
  available: 'Available',
  ringing: 'Ringing',
  busy: 'On a call',
  offline: 'Offline',
  unknown: '',
};

/** Directory of users (with live presence) and the built-in test services. */
export class ContactsPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly presence = new Map<string, PresenceState>();

  constructor(
    private readonly self: string,
    private readonly directory: DirectoryEntry[],
    private readonly services: ServiceEntry[],
    private readonly onDial: DialHandler,
  ) {
    this.search = h('input', {
      class: 'input input-search',
      type: 'search',
      placeholder: 'Search name or extension',
      'aria-label': 'Search contacts',
      oninput: () => this.render(),
    });
    this.list = h('div', { class: 'list', role: 'list' });
    this.el = h(
      'div',
      { class: 'panel-body' },
      h('div', { class: 'search-box' }, icon('search', 16), this.search),
      this.list,
    );
    this.render();
  }

  setPresence(extension: string, state: PresenceState): void {
    this.presence.set(extension, state);
    const row = this.list.querySelector<HTMLElement>(`[data-extension="${CSS.escape(extension)}"]`);
    if (row) this.applyPresence(row, extension);
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const matches = (name: string, ext: string) => !query || name.toLowerCase().includes(query) || ext.includes(query);
    const people = this.directory.filter((u) => u.extension !== this.self && matches(u.name, u.extension));
    const services = this.services.filter((s) => matches(s.name, s.extension));

    clear(this.list);
    if (people.length) {
      this.list.append(h('div', { class: 'list-heading' }, 'People'));
      for (const user of people) this.list.append(this.personRow(user));
    }
    if (services.length) {
      this.list.append(h('div', { class: 'list-heading' }, 'Test services'));
      for (const service of services) this.list.append(this.serviceRow(service));
    }
    if (!people.length && !services.length) {
      this.list.append(
        h('div', { class: 'empty' }, query && /^[0-9*#+]+$/.test(query) ? `No contact matches — dial ${query} from the keypad.` : 'No matches.'),
      );
    }
  }

  private personRow(user: DirectoryEntry): HTMLElement {
    const row = h(
      'div',
      { class: 'list-item contact', role: 'listitem', 'data-extension': user.extension },
      h('div', { class: 'avatar-wrap' }, avatar(user.name, user.extension), h('span', { class: 'presence-dot', title: '' })),
      h(
        'div',
        { class: 'list-text' },
        h('div', { class: 'list-title' }, user.name),
        h('div', { class: 'list-subtitle' }, h('span', {}, `Ext. ${user.extension}`), h('span', { class: 'presence-label' })),
      ),
      this.actions(user.extension, user.name),
    );
    row.addEventListener('dblclick', () => this.onDial(user.extension, user.name, false));
    this.applyPresence(row, user.extension);
    return row;
  }

  private serviceRow(service: ServiceEntry): HTMLElement {
    return h(
      'div',
      { class: 'list-item service', role: 'listitem', title: service.description },
      h('div', { class: 'service-icon' }, icon('flask', 18)),
      h(
        'div',
        { class: 'list-text' },
        h('div', { class: 'list-title' }, service.name, h('span', { class: 'chip' }, service.extension)),
        h('div', { class: 'list-subtitle' }, service.description),
      ),
      this.actions(service.extension, service.name),
    );
  }

  private actions(extension: string, name: string): HTMLElement {
    return h(
      'div',
      { class: 'list-actions' },
      h(
        'button',
        { class: 'icon-btn', title: `Call ${name}`, 'aria-label': `Audio call ${name}`, 'data-action': 'audio', onclick: () => this.onDial(extension, name, false) },
        icon('phone', 18),
      ),
      h(
        'button',
        { class: 'icon-btn', title: `Video call ${name}`, 'aria-label': `Video call ${name}`, 'data-action': 'video', onclick: () => this.onDial(extension, name, true) },
        icon('video', 18),
      ),
    );
  }

  private applyPresence(row: HTMLElement, extension: string): void {
    const state = this.presence.get(extension) ?? 'unknown';
    row.dataset.presence = state;
    const label = row.querySelector('.presence-label');
    if (label) label.textContent = PRESENCE_LABEL[state] ? ` · ${PRESENCE_LABEL[state]}` : '';
    row.querySelector('.presence-dot')?.setAttribute('title', PRESENCE_LABEL[state] || 'Status unknown');
  }
}
