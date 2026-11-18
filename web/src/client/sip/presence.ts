import type * as JsSIP from 'jssip';
import type { Subscriber } from 'jssip/lib/Subscriber';

/** Derived from the PIDF documents Asterisk sends for device-state hints. */
export type PresenceState = 'available' | 'ringing' | 'busy' | 'offline' | 'unknown';

const RESUBSCRIBE_DELAY_MS = 20_000;

export function parsePidf(body: string): PresenceState {
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return 'unknown';
  const basic = doc.getElementsByTagNameNS('*', 'basic')[0]?.textContent?.trim().toLowerCase();
  const note = doc.getElementsByTagNameNS('*', 'note')[0]?.textContent?.trim().toLowerCase() ?? '';
  if (basic === 'closed' || note === 'unavailable') return 'offline';
  if (note === 'ringing') return 'ringing';
  if (note === 'on the phone' || note === 'on hold' || doc.getElementsByTagNameNS('*', 'on-the-phone').length) return 'busy';
  return 'available';
}

/**
 * SUBSCRIBEs to the "presence" event package of each extension and reports the
 * state changes Asterisk NOTIFYs (driven by the dialplan hints).
 */
export class PresenceWatcher {
  private readonly subscriptions = new Map<string, Subscriber>();
  private readonly retryTimers = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly ua: JsSIP.UA,
    private readonly domain: string,
    private readonly onChange: (extension: string, state: PresenceState) => void,
  ) {}

  watch(extensions: string[]): void {
    this.stopped = false;
    for (const extension of extensions) this.subscribe(extension);
  }

  /** Re-create every subscription (after the WebSocket reconnected). */
  refresh(): void {
    const extensions = [...new Set([...this.subscriptions.keys(), ...this.retryTimers.keys()])];
    this.stop();
    this.watch(extensions);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) window.clearTimeout(timer);
    this.retryTimers.clear();
    for (const subscriber of this.subscriptions.values()) {
      subscriber.removeAllListeners();
      try {
        subscriber.terminate();
      } catch {
        // transport already gone
      }
    }
    this.subscriptions.clear();
  }

  private subscribe(extension: string): void {
    if (this.subscriptions.has(extension)) return;
    const timer = this.retryTimers.get(extension);
    if (timer) window.clearTimeout(timer);
    this.retryTimers.delete(extension);

    let subscriber: Subscriber;
    try {
      subscriber = this.ua.subscribe(`sip:${extension}@${this.domain}`, 'presence', 'application/pidf+xml', {
        expires: 600,
      });
    } catch (error) {
      console.warn(`presence subscribe to ${extension} failed`, error);
      this.scheduleRetry(extension);
      return;
    }
    this.subscriptions.set(extension, subscriber);

    subscriber.on('notify', (_isFinal, _request, body) => {
      if (body) this.onChange(extension, parsePidf(body));
    });
    subscriber.on('terminated', () => {
      if (this.subscriptions.get(extension) !== subscriber) return;
      this.subscriptions.delete(extension);
      this.onChange(extension, 'unknown');
      this.scheduleRetry(extension);
    });
    subscriber.subscribe();
  }

  private scheduleRetry(extension: string): void {
    if (this.stopped) return;
    this.retryTimers.set(
      extension,
      window.setTimeout(() => {
        this.retryTimers.delete(extension);
        if (!this.stopped) this.subscribe(extension);
      }, RESUBSCRIBE_DELAY_MS),
    );
  }
}
