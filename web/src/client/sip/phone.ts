import * as JsSIP from 'jssip';
import type { IncomingRTCSessionEvent, RTCSessionEvent } from 'jssip/lib/UA';
import type { Account, Preferences } from '../config';
import { getLocalMedia } from '../media/devices';
import { Emitter } from '../util/emitter';
import { Call } from './call';
import { PresenceWatcher, type PresenceState } from './presence';

export type RegistrationState = 'connecting' | 'registered' | 'reconnecting' | 'failed' | 'stopped';

export interface PhoneEvents {
  registration: { state: RegistrationState; reason?: string };
  /** A new call (incoming or outgoing) was created. */
  call: Call;
  presence: { extension: string; state: PresenceState };
  notice: string;
}

export interface PhoneOptions {
  iceServers: RTCIceServer[];
  getPreferences: () => Preferences;
}

const CONNECT_TIMEOUT_MS = 12_000;
const USER_AGENT = `AsteriskWebPhone/1.0 JsSIP/${JsSIP.version}`;

if (import.meta.env.DEV) JsSIP.debug.enable('JsSIP:*');
else JsSIP.debug.disable();

/** Account registration + call management on top of JsSIP. */
export class Phone extends Emitter<PhoneEvents> {
  state: RegistrationState = 'stopped';
  private ua: JsSIP.UA | undefined;
  private presence: PresenceWatcher | undefined;
  private watched: string[] = [];
  private readonly calls = new Set<Call>();
  private wasRegistered = false;

  constructor(
    readonly account: Account,
    private readonly options: PhoneOptions,
  ) {
    super();
  }

  get activeCalls(): Call[] {
    return [...this.calls];
  }

  /** Connects and registers. Rejects with a user-readable message on failure. */
  start(): Promise<void> {
    if (this.ua) return Promise.resolve();
    const { account } = this;

    let socket: JsSIP.WebSocketInterface;
    try {
      socket = new JsSIP.WebSocketInterface(account.server);
    } catch {
      return Promise.reject(new Error(`Invalid server address "${account.server}".`));
    }

    const ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${account.extension}@${account.domain}`,
      authorization_user: account.extension,
      password: account.password,
      display_name: account.displayName || undefined,
      register: true,
      register_expires: 300,
      session_timers: true,
      user_agent: USER_AGENT,
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
      no_answer_timeout: 90,
    });
    this.ua = ua;
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) {
          this.stop();
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = window.setTimeout(
        () => settle(new Error(`Could not reach the server at ${account.server}. Is it running, and is its certificate trusted?`)),
        CONNECT_TIMEOUT_MS,
      );

      ua.on('connecting', () => {
        if (this.wasRegistered) this.setState('reconnecting');
      });
      ua.on('disconnected', () => {
        if (this.state === 'registered') {
          this.setState('reconnecting', 'Connection lost — reconnecting…');
        }
      });
      ua.on('registered', () => {
        const reconnect = this.wasRegistered;
        this.wasRegistered = true;
        this.setState('registered');
        settle();
        if (reconnect) this.presence?.refresh();
      });
      ua.on('unregistered', () => {
        if (this.state === 'registered') this.setState('reconnecting', 'Registration expired');
      });
      ua.on('registrationFailed', (e) => {
        const status = e.response?.status_code;
        const message =
          e.cause === JsSIP.C.causes.AUTHENTICATION_ERROR || status === 401 || status === 403
            ? 'Wrong extension or password.'
            : status
              ? `Registration failed: ${status} ${e.response.reason_phrase}`
              : `Registration failed (${e.cause ?? 'unknown error'}).`;
        if (!settled) settle(new Error(message));
        else this.setState('failed', message);
      });
      ua.on('newRTCSession', (e: RTCSessionEvent) => {
        if (e.originator === 'remote') this.onIncoming(e as IncomingRTCSessionEvent);
      });

      try {
        ua.start();
      } catch (error) {
        settle(new Error(`Could not start the SIP stack: ${(error as Error).message}`));
      }
    });
  }

  stop(): void {
    const ua = this.ua;
    if (!ua) return;
    this.ua = undefined;
    this.presence?.stop();
    this.presence = undefined;
    for (const call of this.calls) call.hangup();
    try {
      ua.removeAllListeners();
      ua.stop();
    } catch {
      // already stopped
    }
    this.setState('stopped');
  }

  /** Track presence for these extensions (SUBSCRIBE / NOTIFY, application/pidf+xml). */
  watchPresence(extensions: string[]): void {
    this.watched = extensions.filter((ext) => ext !== this.account.extension);
    if (!this.ua) return;
    this.presence?.stop();
    this.presence = new PresenceWatcher(this.ua, this.account.domain, (extension, state) =>
      this.emit('presence', { extension, state }),
    );
    this.presence.watch(this.watched);
  }

  targetUri(number: string): string {
    const clean = number.trim();
    return clean.startsWith('sip:') ? clean : `sip:${clean}@${this.account.domain}`;
  }

  /** Places a call. Captures media first so permission prompts happen before ringing. */
  async call(number: string, name: string, video: boolean): Promise<Call> {
    const ua = this.ua;
    if (!ua || this.state !== 'registered') throw new Error('Not connected to the phone system.');
    const dialable = number.replace(/[\s().-]/g, '');
    if (!/^(sip:.+|[0-9*#+]+)$/.test(dialable)) throw new Error('Enter a valid number or extension.');
    if (this.calls.size > 0) throw new Error('Finish the current call first.');

    const media = await getLocalMedia(this.options.getPreferences(), video);
    if (media.videoError) this.emit('notice', `${media.videoError} Calling with audio only.`);
    if (!this.ua) {
      media.stream.getTracks().forEach((t) => t.stop());
      throw new Error('Disconnected.');
    }
    const call = Call.outgoing(ua, this.targetUri(dialable), dialable.replace(/^sip:([^@]+)@.*/, '$1'), name, media.stream, {
      iceServers: this.options.iceServers,
      getPreferences: this.options.getPreferences,
    });
    this.track(call);
    return call;
  }

  private onIncoming(e: IncomingRTCSessionEvent): void {
    const call = Call.incoming(e.session, e.request.body ?? '', {
      iceServers: this.options.iceServers,
      getPreferences: this.options.getPreferences,
    });
    if (this.calls.size > 0) {
      // Single-line phone: tell the caller we are busy.
      call.decline();
      this.emit('notice', `Missed a call from ${call.remoteName} while busy.`);
      return;
    }
    this.track(call);
  }

  private track(call: Call): void {
    this.calls.add(call);
    call.on('ended', () => this.calls.delete(call));
    this.emit('call', call);
  }

  private setState(state: RegistrationState, reason?: string): void {
    if (this.state === state && !reason) return;
    this.state = state;
    this.emit('registration', { state, reason });
  }
}
