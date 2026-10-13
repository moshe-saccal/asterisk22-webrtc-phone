/**
 * Call progress tones generated with WebAudio (no audio files needed):
 * incoming ringtone, ringback, busy/error tones and DTMF key feedback.
 */

const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], A: [697, 1633],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], B: [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], C: [852, 1633],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], D: [941, 1633],
};

type Pattern = 'ringtone' | 'ringback';

export class TonePlayer {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private loop: { pattern: Pattern; timer: number; nodes: Set<AudioScheduledSourceNode> } | undefined;
  private volume = 0.6;
  private sinkId = '';

  /** Must be called from a user gesture at least once so browsers allow audio. */
  unlock(): void {
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.sinkId = deviceId;
    const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | undefined;
    if (context?.setSinkId) {
      try {
        await context.setSinkId(deviceId);
      } catch {
        // unsupported device — keep default output
      }
    }
  }

  startRingtone(): void {
    this.startLoop('ringtone');
  }

  startRingback(): void {
    this.startLoop('ringback');
  }

  stopLoop(): void {
    if (!this.loop) return;
    window.clearInterval(this.loop.timer);
    for (const node of this.loop.nodes) {
      try {
        node.stop();
      } catch {
        // already stopped
      }
    }
    this.loop = undefined;
  }

  /** Short busy / failure cadence (480+620 Hz). */
  playBusy(): void {
    const context = this.ensureContext();
    const start = context.currentTime + 0.05;
    for (let i = 0; i < 3; i++) this.tone([480, 620], start + i * 0.5, 0.25, 0.25);
  }

  /** Soft descending blip when a call ends. */
  playHangup(): void {
    const context = this.ensureContext();
    const start = context.currentTime + 0.02;
    this.tone([620], start, 0.12, 0.2);
    this.tone([480], start + 0.14, 0.18, 0.2);
  }

  playDtmf(digit: string): void {
    const freqs = DTMF_FREQUENCIES[digit.toUpperCase()];
    if (!freqs) return;
    const context = this.ensureContext();
    this.tone(freqs, context.currentTime + 0.01, 0.12, 0.18);
  }

  private startLoop(pattern: Pattern): void {
    if (this.loop?.pattern === pattern) return;
    this.stopLoop();
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume();
    const nodes = new Set<AudioScheduledSourceNode>();
    const period = pattern === 'ringtone' ? 3000 : 6000;
    const schedule = () => {
      const t = context.currentTime + 0.05;
      if (pattern === 'ringtone') {
        // Pleasant two-note chime, twice.
        for (const [offset, freq] of [[0, 784], [0.18, 1047], [0.6, 784], [0.78, 1047]] as const) {
          this.tone([freq, freq * 2], t + offset, 0.32, 0.35, nodes);
        }
      } else {
        // North American ringback: 440 + 480 Hz, 2 s on, 4 s off.
        this.tone([440, 480], t, 2, 0.12, nodes);
      }
    };
    schedule();
    this.loop = { pattern, nodes, timer: window.setInterval(schedule, period) };
  }

  private tone(freqs: readonly number[], start: number, duration: number, level: number, track?: Set<AudioScheduledSourceNode>): void {
    const context = this.ensureContext();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level / freqs.length, start + 0.015);
    gain.gain.setValueAtTime(level / freqs.length, start + Math.max(0.02, duration - 0.04));
    gain.gain.linearRampToValueAtTime(0, start + duration);
    gain.connect(this.master!);
    for (const freq of freqs) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(start);
      osc.stop(start + duration + 0.02);
      if (track) {
        track.add(osc);
        osc.onended = () => track.delete(osc);
      }
    }
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
      if (this.sinkId) void this.setOutputDevice(this.sinkId);
    }
    return this.context;
  }
}
