/** Periodic RTCPeerConnection statistics: bitrates, codecs, loss, RTT, resolution. */

export interface StreamStats {
  codec?: string;
  bitrateIn?: number;
  bitrateOut?: number;
  packetsLostPct?: number;
  jitterMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  sendWidth?: number;
  sendHeight?: number;
  sendFps?: number;
  framesDecoded?: number;
  /** Remote audio level 0..1 (inbound audio only). */
  level?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  bytesSent?: number;
}

export interface CallStats {
  audio: StreamStats;
  video: StreamStats;
  rttMs?: number;
  localCandidate?: string;
  remoteCandidate?: string;
  transport?: string;
  dtlsState?: string;
  srtpCipher?: string;
  /** 0 = no media, 1 = poor … 4 = excellent */
  quality: 0 | 1 | 2 | 3 | 4;
  /** Remote video frames are currently being decoded. */
  receivingVideo: boolean;
  /** Remote audio packets are currently arriving. */
  receivingAudio: boolean;
}

interface Snapshot {
  at: number;
  bytesIn: Record<string, number>;
  bytesOut: Record<string, number>;
  packetsReceived: Record<string, number>;
  packetsLost: Record<string, number>;
  framesDecoded: number;
}

type AnyStats = Record<string, unknown> & { id: string; type: string };

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class StatsSampler {
  private previous: Snapshot | undefined;
  private lastVideoFrameAt = 0;
  private lastAudioPacketAt = 0;

  constructor(private readonly pc: RTCPeerConnection) {}

  async sample(): Promise<CallStats> {
    const report = await this.pc.getStats();
    const all = new Map<string, AnyStats>();
    report.forEach((s: AnyStats) => all.set(s.id, s));

    const now = performance.now();
    const snapshot: Snapshot = { at: now, bytesIn: {}, bytesOut: {}, packetsReceived: {}, packetsLost: {}, framesDecoded: 0 };
    const stats: CallStats = { audio: {}, video: {}, quality: 0, receivingVideo: false, receivingAudio: false };
    const codecName = (id: unknown) => {
      const codec = typeof id === 'string' ? all.get(id) : undefined;
      const mime = typeof codec?.mimeType === 'string' ? codec.mimeType.split('/')[1] : undefined;
      return mime ? mime.toUpperCase().replace('TELEPHONE-EVENT', 'DTMF') : undefined;
    };
    let remoteLoss: number | undefined;
    let remoteRtt: number | undefined;

    for (const s of all.values()) {
      const kind = s.kind === 'video' ? 'video' : s.kind === 'audio' ? 'audio' : undefined;
      if (!kind) continue;
      const target = stats[kind];
      if (s.type === 'inbound-rtp') {
        target.codec = codecName(s.codecId) ?? target.codec;
        target.packetsReceived = (target.packetsReceived ?? 0) + (num(s.packetsReceived) ?? 0);
        target.bytesReceived = (target.bytesReceived ?? 0) + (num(s.bytesReceived) ?? 0);
        snapshot.bytesIn[kind] = (snapshot.bytesIn[kind] ?? 0) + (num(s.bytesReceived) ?? 0);
        snapshot.packetsReceived[kind] = (snapshot.packetsReceived[kind] ?? 0) + (num(s.packetsReceived) ?? 0);
        snapshot.packetsLost[kind] = (snapshot.packetsLost[kind] ?? 0) + Math.max(0, num(s.packetsLost) ?? 0);
        const jitter = num(s.jitter);
        if (jitter !== undefined) target.jitterMs = Math.round(jitter * 1000);
        if (kind === 'audio') target.level = num(s.audioLevel) ?? target.level;
        if (kind === 'video') {
          target.width = num(s.frameWidth) ?? target.width;
          target.height = num(s.frameHeight) ?? target.height;
          target.fps = num(s.framesPerSecond) ?? target.fps;
          target.framesDecoded = (target.framesDecoded ?? 0) + (num(s.framesDecoded) ?? 0);
          snapshot.framesDecoded += num(s.framesDecoded) ?? 0;
        }
      } else if (s.type === 'outbound-rtp') {
        target.codec = target.codec ?? codecName(s.codecId);
        target.bytesSent = (target.bytesSent ?? 0) + (num(s.bytesSent) ?? 0);
        snapshot.bytesOut[kind] = (snapshot.bytesOut[kind] ?? 0) + (num(s.bytesSent) ?? 0);
        if (kind === 'video') {
          target.sendWidth = num(s.frameWidth) ?? target.sendWidth;
          target.sendHeight = num(s.frameHeight) ?? target.sendHeight;
          target.sendFps = num(s.framesPerSecond) ?? target.sendFps;
        }
      } else if (s.type === 'remote-inbound-rtp') {
        const fraction = num(s.fractionLost);
        if (fraction !== undefined) remoteLoss = Math.max(remoteLoss ?? 0, fraction * 100);
        const rtt = num(s.roundTripTime);
        if (rtt !== undefined) remoteRtt = rtt * 1000;
      }
    }

    // Selected candidate pair → RTT and network path.
    let pair: AnyStats | undefined;
    for (const s of all.values()) {
      if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
        pair = all.get(s.selectedCandidatePairId);
        stats.dtlsState = typeof s.dtlsState === 'string' ? s.dtlsState : undefined;
        stats.srtpCipher = typeof s.srtpCipher === 'string' ? s.srtpCipher : undefined;
        if (pair) break;
      }
    }
    if (!pair) {
      for (const s of all.values()) {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
      }
    }
    if (pair) {
      const rtt = num(pair.currentRoundTripTime);
      if (rtt !== undefined) stats.rttMs = Math.round(rtt * 1000);
      const local = typeof pair.localCandidateId === 'string' ? all.get(pair.localCandidateId) : undefined;
      const remote = typeof pair.remoteCandidateId === 'string' ? all.get(pair.remoteCandidateId) : undefined;
      if (local) stats.localCandidate = `${local.candidateType} ${local.address ?? local.ip ?? ''}:${local.port ?? ''}`;
      if (remote) stats.remoteCandidate = `${remote.candidateType} ${remote.address ?? remote.ip ?? ''}:${remote.port ?? ''}`;
      if (local?.protocol) stats.transport = String(local.protocol).toUpperCase() + (local.candidateType === 'relay' ? ' (TURN relay)' : '');
    }
    if (stats.rttMs === undefined && remoteRtt !== undefined) stats.rttMs = Math.round(remoteRtt);

    // Rates since the previous sample.
    const prev = this.previous;
    if (prev) {
      const seconds = (now - prev.at) / 1000;
      if (seconds > 0) {
        for (const kind of ['audio', 'video'] as const) {
          const inDelta = (snapshot.bytesIn[kind] ?? 0) - (prev.bytesIn[kind] ?? 0);
          const outDelta = (snapshot.bytesOut[kind] ?? 0) - (prev.bytesOut[kind] ?? 0);
          stats[kind].bitrateIn = Math.max(0, (inDelta * 8) / seconds);
          stats[kind].bitrateOut = Math.max(0, (outDelta * 8) / seconds);
          const received = (snapshot.packetsReceived[kind] ?? 0) - (prev.packetsReceived[kind] ?? 0);
          const lost = (snapshot.packetsLost[kind] ?? 0) - (prev.packetsLost[kind] ?? 0);
          if (received + lost > 0) stats[kind].packetsLostPct = Math.max(0, (lost / (received + lost)) * 100);
          if (kind === 'audio' && received > 0) this.lastAudioPacketAt = now;
        }
        if (snapshot.framesDecoded > prev.framesDecoded) this.lastVideoFrameAt = now;
      }
    }
    this.previous = snapshot;

    stats.receivingVideo = now - this.lastVideoFrameAt < 1500 && this.lastVideoFrameAt > 0;
    stats.receivingAudio = now - this.lastAudioPacketAt < 2500 && this.lastAudioPacketAt > 0;

    const loss = Math.max(stats.audio.packetsLostPct ?? 0, stats.video.packetsLostPct ?? 0, remoteLoss ?? 0);
    const rtt = stats.rttMs ?? 0;
    if (!stats.receivingAudio && !stats.receivingVideo) stats.quality = prev ? 0 : 4;
    else if (loss < 1 && rtt < 150) stats.quality = 4;
    else if (loss < 3 && rtt < 300) stats.quality = 3;
    else if (loss < 8 && rtt < 500) stats.quality = 2;
    else stats.quality = 1;
    return stats;
  }
}
