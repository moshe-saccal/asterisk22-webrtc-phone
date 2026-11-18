import { clearAccount, savePreferences, type Preferences, type ServerConfig } from '../config';
import { getLocalMedia, stopStream } from '../media/devices';
import { TonePlayer } from '../media/tones';
import type { Call } from '../sip/call';
import { Phone, type RegistrationState } from '../sip/phone';
import { avatar } from './avatar';
import { CallView } from './callview';
import { ContactsPanel } from './contacts';
import { DialPad } from './dialpad';
import { h } from './dom';
import { CallHistory } from './history';
import { icon } from './icons';
import { IncomingCallModal } from './incoming';
import { RecentsPanel } from './recents';
import { SettingsModal } from './settings';
import { toast } from './toast';

type Tab = 'contacts' | 'recents' | 'keypad';

const STATUS_TEXT: Record<RegistrationState, string> = {
  connecting: 'Connecting…',
  registered: 'Online',
  reconnecting: 'Reconnecting…',
  failed: 'Offline',
  stopped: 'Signed out',
};

/** The signed-in application shell. */
export class PhoneApp {
  readonly el: HTMLElement;
  private readonly history: CallHistory;
  private readonly contacts: ContactsPanel;
  private readonly recents: RecentsPanel;
  private readonly dialpad: DialPad;
  private readonly stage: HTMLElement;
  private readonly statusPill: HTMLElement;
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly missedBadge: HTMLElement;
  private callView: CallView | undefined;
  private incomingModal: IncomingCallModal | undefined;
  private incomingCall: Call | undefined;
  private incomingNotification: Notification | undefined;
  private settings: SettingsModal | undefined;
  private currentCall: Call | undefined;
  private missed = 0;
  private readonly baseTitle = document.title;
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKey(event);
  private readonly onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (this.currentCall && !this.currentCall.isEnded) event.preventDefault();
  };
  private readonly onPageHide = () => this.phone.stop();

  constructor(
    private readonly phone: Phone,
    private readonly config: ServerConfig,
    private preferences: Preferences,
    private readonly tones: TonePlayer,
    private readonly onSignOut: () => void,
  ) {
    const account = phone.account;
    this.history = new CallHistory(account.extension);
    const dial = (number: string, name: string, video: boolean) => void this.placeCall(number, name, video);
    this.contacts = new ContactsPanel(account.extension, config.directory, config.services, dial);
    this.recents = new RecentsPanel(this.history, dial);
    this.dialpad = new DialPad(tones, (number, video) => {
      const known = [...config.directory, ...config.services].find((entry) => entry.extension === number);
      void this.placeCall(number, known?.name ?? number, video);
    });
    tones.setVolume(preferences.ringtoneVolume);
    void tones.setOutputDevice(preferences.audioOutput);

    this.statusPill = h('div', { class: 'status-pill', role: 'status' }, h('span', { class: 'status-dot' }), h('span', { class: 'status-text' }));
    this.missedBadge = h('span', { class: 'tab-badge', hidden: true });

    const tab = (name: Tab, label: string, iconName: 'users' | 'clock' | 'keypad', badge?: HTMLElement) => {
      const button = h(
        'button',
        { class: 'tab', type: 'button', role: 'tab', 'data-tab': name, onclick: () => this.selectTab(name) },
        icon(iconName, 18),
        h('span', {}, label),
        badge ?? null,
      );
      this.tabButtons.set(name, button);
      return button;
    };

    this.stage = h('main', { class: 'stage' }, this.dialpad.el);
    const sidebar = h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        tab('contacts', 'Contacts', 'users'),
        tab('recents', 'Recents', 'clock', this.missedBadge),
        tab('keypad', 'Keypad', 'keypad'),
      ),
      h('div', { class: 'panel', 'data-panel': 'contacts' }, this.contacts.el),
      h('div', { class: 'panel', 'data-panel': 'recents' }, this.recents.el),
    );

    this.el = h(
      'div',
      { class: 'app' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('logo', 20)), h('span', { class: 'brand-name' }, 'Asterisk Phone')),
        this.statusPill,
        h(
          'div',
          { class: 'topbar-right' },
          h(
            'div',
            { class: 'me' },
            avatar(account.displayName || account.extension, account.extension, 'sm'),
            h('div', { class: 'me-text' }, h('div', { class: 'me-name' }, account.displayName || `Extension ${account.extension}`), h('div', { class: 'me-ext muted' }, `Ext. ${account.extension}`)),
          ),
          h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onclick: () => this.openSettings() }, icon('settings', 20)),
          h('button', { class: 'icon-btn', 'aria-label': 'Sign out', title: 'Sign out', onclick: () => this.signOut() }, icon('logout', 20)),
        ),
      ),
      h('div', { class: 'workspace' }, sidebar, this.stage),
    );

    phone.on('registration', ({ state, reason }) => {
      this.renderStatus(state);
      if (reason) toast(reason, state === 'registered' ? 'success' : 'warning');
      if (state === 'registered' && reason === undefined && this.el.dataset.reconnecting === 'true') toast('Reconnected', 'success', 2500);
      this.el.dataset.reconnecting = String(state === 'reconnecting');
    });
    phone.on('call', (call) => this.onNewCall(call));
    phone.on('presence', ({ extension, state }) => this.contacts.setPresence(extension, state));
    phone.on('notice', (message) => toast(message, 'warning'));
    phone.watchPresence(config.directory.map((u) => u.extension));

    this.renderStatus(phone.state);
    this.selectTab(matchMedia('(max-width: 860px)').matches ? 'keypad' : 'contacts');
    document.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('pagehide', this.onPageHide);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('pagehide', this.onPageHide);
    this.callView?.destroy();
    this.incomingModal?.destroy();
    this.settings?.close();
    this.tones.stopLoop();
    document.title = this.baseTitle;
    this.el.remove();
  }

  // ---------------------------------------------------------------------------

  private selectTab(tab: Tab): void {
    this.el.dataset.tab = tab;
    for (const [name, button] of this.tabButtons) {
      button.classList.toggle('active', name === tab);
      button.setAttribute('aria-selected', String(name === tab));
    }
    if (tab === 'recents') {
      this.missed = 0;
      this.missedBadge.hidden = true;
      this.recents.render();
    }
    if (tab === 'keypad') this.dialpad.focus();
  }

  private renderStatus(state: RegistrationState): void {
    this.statusPill.dataset.state = state;
    this.statusPill.querySelector('.status-text')!.textContent = STATUS_TEXT[state];
  }

  private async placeCall(number: string, name: string, video: boolean): Promise<void> {
    this.tones.unlock();
    if (this.currentCall || this.incomingCall) {
      toast('Finish the current call first.', 'warning');
      return;
    }
    if (number === this.phone.account.extension) {
      toast('That is your own extension.', 'warning');
      return;
    }
    try {
      await this.phone.call(number, name, video);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  private onNewCall(call: Call): void {
    if (call.direction === 'incoming') {
      this.showIncoming(call);
    } else {
      this.showCall(call);
    }
    call.on('ended', () => {
      const entry = this.history.add(call);
      this.recents.render();
      if (entry.outcome === 'missed') {
        this.missed += 1;
        this.missedBadge.textContent = String(this.missed);
        this.missedBadge.hidden = false;
        toast(`Missed call from ${call.remoteName}`, 'info');
      }
      if (this.incomingCall === call) this.hideIncoming();
    });
  }

  private showIncoming(call: Call): void {
    this.incomingCall = call;
    this.tones.startRingtone();
    this.incomingModal = new IncomingCallModal(call, {
      onAnswer: (video) => void this.answer(call, video),
      onDecline: () => {
        call.decline();
        this.hideIncoming();
      },
    });
    document.body.append(this.incomingModal.el);
    document.title = `Incoming call — ${call.remoteName}`;

    if (this.preferences.desktopNotifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        this.incomingNotification = new Notification(call.videoCall ? 'Incoming video call' : 'Incoming call', {
          body: `${call.remoteName}${call.remoteName !== call.remoteNumber ? ` (${call.remoteNumber})` : ''}`,
          tag: 'incoming-call',
          requireInteraction: true,
        });
        this.incomingNotification.onclick = () => {
          window.focus();
          this.incomingNotification?.close();
        };
      } catch {
        // notifications unavailable (e.g. service-worker only platforms)
      }
    }
  }

  private hideIncoming(): void {
    this.tones.stopLoop();
    this.incomingModal?.destroy();
    this.incomingModal = undefined;
    this.incomingCall = undefined;
    this.incomingNotification?.close();
    this.incomingNotification = undefined;
    document.title = this.baseTitle;
  }

  private async answer(call: Call, video: boolean): Promise<void> {
    this.tones.unlock();
    this.hideIncoming();
    if (call.isEnded) return;
    try {
      const media = await getLocalMedia(this.preferences, video);
      if (call.isEnded) {
        stopStream(media.stream);
        return;
      }
      if (media.videoError) toast(`${media.videoError} Answering with audio only.`, 'warning');
      this.showCall(call);
      call.answer(media.stream, video && !media.videoError);
    } catch (error) {
      toast((error as Error).message, 'error');
      call.decline();
    }
  }

  private showCall(call: Call): void {
    this.currentCall = call;
    this.callView?.destroy();
    this.callView = new CallView(call, {
      tones: this.tones,
      directory: this.config.directory.filter((u) => u.extension !== this.phone.account.extension),
      outputDevice: () => this.preferences.audioOutput,
      transferUri: (number) => this.phone.targetUri(number),
      onClosed: () => {
        if (this.currentCall !== call) return;
        this.callView?.destroy();
        this.callView = undefined;
        this.currentCall = undefined;
        this.el.classList.remove('in-call');
        this.stage.replaceChildren(this.dialpad.el);
      },
    });
    this.el.classList.add('in-call');
    this.stage.replaceChildren(this.callView.el);
  }

  private openSettings(): void {
    if (this.settings) return;
    this.settings = new SettingsModal(
      this.preferences,
      this.phone.account,
      () => STATUS_TEXT[this.phone.state],
      this.tones,
      (preferences) => {
        this.preferences = preferences;
        savePreferences(preferences);
        this.tones.setVolume(preferences.ringtoneVolume);
        void this.tones.setOutputDevice(preferences.audioOutput);
        this.callView?.setOutputDevice(preferences.audioOutput);
        toast('Settings saved', 'success', 2500);
      },
      () => (this.settings = undefined),
      Boolean(this.currentCall),
    );
    document.body.append(this.settings.el);
  }

  /** Current preferences (read by the phone when it captures media). */
  getPreferences(): Preferences {
    return this.preferences;
  }

  private signOut(): void {
    if (this.currentCall && !this.currentCall.isEnded && !confirm('End the current call and sign out?')) return;
    clearAccount();
    this.phone.stop();
    this.onSignOut();
  }

  private handleKey(event: KeyboardEvent): void {
    if (this.settings || this.incomingCall || this.currentCall) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.dialpad.handleKey(event)) {
      event.preventDefault();
      if (this.el.dataset.tab !== 'keypad' && matchMedia('(max-width: 860px)').matches) this.selectTab('keypad');
    }
  }
}
