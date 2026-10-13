import type { Call } from '../sip/call';

export type HistoryOutcome = 'answered' | 'missed' | 'declined' | 'cancelled' | 'failed';

export interface HistoryEntry {
  id: string;
  number: string;
  name: string;
  direction: 'incoming' | 'outgoing';
  video: boolean;
  startedAt: number;
  durationSeconds: number;
  outcome: HistoryOutcome;
  reason: string;
}

const MAX_ENTRIES = 200;

export class CallHistory {
  private entries: HistoryEntry[];
  private readonly key: string;

  constructor(extension: string) {
    this.key = `webphone.history.${extension}`;
    try {
      this.entries = JSON.parse(localStorage.getItem(this.key) ?? '[]') as HistoryEntry[];
    } catch {
      this.entries = [];
    }
  }

  get all(): readonly HistoryEntry[] {
    return this.entries;
  }

  add(call: Call): HistoryEntry {
    const info = call.endInfo;
    let outcome: HistoryOutcome = 'answered';
    if (!call.answeredAt) {
      if (call.direction === 'incoming') outcome = info?.originator === 'local' ? 'declined' : 'missed';
      else outcome = info?.originator === 'local' ? 'cancelled' : 'failed';
    }
    const entry: HistoryEntry = {
      id: `${call.createdAt}-${call.id}`,
      number: call.remoteNumber,
      name: call.remoteName,
      direction: call.direction,
      video: call.videoCall,
      startedAt: call.createdAt,
      durationSeconds: Math.round(call.durationSeconds),
      outcome,
      reason: info?.reason ?? '',
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    this.save();
    return entry;
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.entries));
    } catch {
      // ignore quota / private mode
    }
  }
}
