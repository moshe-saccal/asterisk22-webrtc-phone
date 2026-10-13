import * as JsSIP from 'jssip';
import type {
  EndEvent,
  HoldEvent,
  IceCandidateEvent,
  IncomingEvent,
  OutgoingEvent,
  PeerConnectionEvent,
  ReferEvent,
  RTCSession,
  RTCSessionEventMap,
  SDPEvent,
} from 'jssip/lib/RTCSession';
import type { IncomingResponse } from 'jssip/lib/SIPMessage';
import type { Preferences } from '../config';
import { createPlaceholderVideoTrack, getCameraTrack, stopStream } from '../media/devices';
import { StatsSampler, type CallStats } from '../media/stats';
import { Emitter } from '../util/emitter';

export type CallDirection = 'incoming' | 'outgoing';

/**
 *  outgoing: calling → ringing → active → ended
 *  incoming: incoming → connecting → active → ended
 */
export type CallStatus = 'calling' | 'ringing' | 'incoming' | 'connecting' | 'active' | 'ended';

export interface CallEnd {
  reason: string;
  originator: 'local' | 'remote' | 'system';
  /** SIP status code when the call failed with a response. */
  code?: number;
  /** Ended before it was ever answered. */
  unanswered: boolean;
  /** An error (not a normal hang-up or rejection) ended the call. */
  error: boolean;
}

export interface CallEvents {
  status: CallStatus;
  /** Local or remote tracks changed (camera toggled, remote video arrived, ...). */
  media: void;
  /** Mute / hold / screen-share flags changed. */
  controls: void;
  ended: CallEnd;
  notice: string;
}

export interface CallOptions {
  iceServers: RTCIceServer[];
  getPreferences: () => Preferences;
}

let nextId = 1;

export class Call extends Emitter<CallEvents> {
  readonly id = `call-${nextId++}`;
  readonly remoteStream = new MediaStream();
  status: CallStatus;
  localStream: MediaStream | null = null;
  remoteName: string;
  readonly remoteNumber: string;
  /** Video was part of the call setup (requested by us, or offered by the caller). */
  readonly videoCall: boolean;
  createdAt = Date.now();
  answeredAt?: number;
  endedAt?: number;
  endInfo?: CallEnd;

  micMuted = false;
  cameraOn = false;
  localHold = false;
  remoteHold = false;
  screenSharing = false;
  earlyMedia = false;
  transferring = false;
  mediaState: RTCPeerConnectionState = 'new';

  private session: RTCSession | undefined;
  private pc: RTCPeerConnection | undefined;
  private videoSender: RTCRtpSender | undefined;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private placeholderTrack: MediaStreamTrack | null = null;
  private statsSampler: StatsSampler | undefined;
  private iceRound: (() => void) | undefined;
  private iceTimer: number | undefined;
  private mediaFailTimer: number | undefined;
  /** REFER accepted (202) / transfer completed (NOTIFY 200). */
  private transferPending = false;
  private transferred = false;
  lastLocalSdp = '';
  lastRemoteSdp = '';

  private constructor(
    readonly direction: CallDirection,
    remoteNumber: string,
    remoteName: string,
    videoCall: boolean,
    private readonly options: CallOptions,
  ) {
    super();
    this.remoteNumber = remoteNumber;
    this.remoteName = remoteName || remoteNumber;
    this.videoCall = videoCall;
    this.status = direction === 'incoming' ? 'incoming' : 'calling';
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  static outgoing(
    ua: JsSIP.UA,
    target: string,
    number: string,
    name: string,
    localStream: MediaStream,
    options: CallOptions,
  ): Call {
    const video = localStream.getVideoTracks().length > 0;
    const call = new Call('outgoing', number, name, video, options);
    call.localStream = localStream;
    call.cameraTrack = localStream.getVideoTracks()[0] ?? null;
    call.cameraOn = Boolean(call.cameraTrack);
    const session = ua.call(target, {
      mediaStream: localStream,
      pcConfig: call.pcConfig(),
      eventHandlers: call.handlers(),
      sessionTimersExpires: 600,
    });
    call.session = session;
    return call;
  }

  static incoming(session: RTCSession, offerSdp: string, options: CallOptions): Call {
    const identity = session.remote_identity;
    const number = identity?.uri?.user ?? 'unknown';
    const name = identity?.display_name ?? '';
    const offersVideo = /^m=video [1-9]\d*/m.test(offerSdp);
    const call = new Call('incoming', number, name, offersVideo, options);
    call.session = session;
    const handlers = call.handlers();
    for (const [event, handler] of Object.entries(handlers)) {
      session.on(event as keyof RTCSessionEventMap, handler as never);
    }
    return call;
  }

  private pcConfig(): RTCConfiguration {
    return {
      iceServers: this.options.iceServers,
      bundlePolicy: 'balanced',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    };
  }

  private handlers(): Partial<RTCSessionEventMap> {
    return {
      peerconnection: (e: PeerConnectionEvent) => this.attachPeerConnection(e.peerconnection),
      icecandidate: (e: IceCandidateEvent) => this.onIceCandidate(e),
      sdp: (e: SDPEvent) => {
        if (e.originator === 'local') this.lastLocalSdp = e.sdp;
        else this.lastRemoteSdp = e.sdp;
      },
      progress: (e: IncomingEvent | OutgoingEvent) => {
        if (this.direction !== 'outgoing' || !('response' in e)) return;
        if (e.response.body) this.earlyMedia = true;
        this.setStatus('ringing');
      },
      accepted: () => this.onAnswered(),
      confirmed: () => this.onAnswered(),
      ended: (e: EndEvent) => this.finish(e),
      failed: (e: EndEvent) => this.finish(e),
      hold: (e: HoldEvent) => this.onHold(e.originator, true),
      unhold: (e: HoldEvent) => this.onHold(e.originator, false),
      muted: () => this.syncMute(),
      unmuted: () => this.syncMute(),
      refer: (e: ReferEvent) => e.reject(),
      'peerconnection:setremotedescriptionfailed': (error: unknown) =>
        console.error('setRemoteDescription failed', error),
      'peerconnection:createanswerfailed': (error: unknown) => console.error('createAnswer failed', error),
      'peerconnection:createofferfailed': (error: unknown) => console.error('createOffer failed', error),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get durationSeconds(): number {
    if (!this.answeredAt) return 0;
    return ((this.endedAt ?? Date.now()) - this.answeredAt) / 1000;
  }

  get isEnded(): boolean {
    return this.status === 'ended';
  }

  /** The call has a video line we are allowed to send on. */
  get canSendVideo(): boolean {
    return Boolean(this.videoSender);
  }

  /** The track currently shown in the local preview (screen share or camera). */
  get localVideoTrack(): MediaStreamTrack | null {
    return this.screenTrack ?? (this.cameraOn ? this.cameraTrack : null);
  }

  /** Answer an incoming call. With `video` false and a video offer, the camera starts off but can be enabled later. */
  answer(localStream: MediaStream, video: boolean): void {
    if (!this.session || this.direction !== 'incoming' || this.status !== 'incoming') return;
    this.localStream = localStream;
    this.cameraTrack = localStream.getVideoTracks()[0] ?? null;
    this.cameraOn = Boolean(this.cameraTrack) && video;
    if (this.videoCall && !this.cameraTrack) {
      // Keep a send-capable video line so the camera can be switched on mid-call.
      this.placeholderTrack = createPlaceholderVideoTrack();
      localStream.addTrack(this.placeholderTrack);
    }
    this.setStatus('connecting');
    this.session.answer({
      mediaStream: localStream,
      pcConfig: this.pcConfig(),
      sessionTimersExpires: 600,
    });
    this.emit('media', undefined);
  }

  /** Decline an incoming call (caller hears busy). */
  decline(): void {
    if (this.session && this.status === 'incoming') {
      this.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
    }
  }

  hangup(): void {
    if (!this.session || this.isEnded) return;
    try {
      if (this.status === 'incoming') this.decline();
      else this.session.terminate();
    } catch (error) {
      console.warn('terminate failed', error);
      this.finish({ originator: 'local', cause: JsSIP.C.causes.BYE });
    }
  }

  toggleMute(): void {
    if (!this.session || this.isEnded) return;
    if (this.micMuted) this.session.unmute({ audio: true });
    else this.session.mute({ audio: true });
  }

  async setCamera(on: boolean): Promise<void> {
    const sender = this.videoSender;
    if (!sender || this.isEnded || on === this.cameraOn) return;
    if (on) {
      const track = await getCameraTrack(this.options.getPreferences());
      if (this.isEnded) {
        track.stop();
        return;
      }
      track.enabled = !this.localHold && !this.remoteHold;
      this.cameraTrack = track;
      this.localStream?.addTrack(track);
      if (!this.screenTrack) await sender.replaceTrack(track);
      this.cameraOn = true;
    } else {
      const track = this.cameraTrack;
      if (!this.screenTrack) await sender.replaceTrack(null);
      if (track) {
        track.stop();
        this.localStream?.removeTrack(track);
      }
      this.cameraTrack = null;
      this.cameraOn = false;
    }
    this.emit('media', undefined);
    this.emit('controls', undefined);
  }

  /** Swap the camera for another device without renegotiating. */
  async switchCamera(): Promise<void> {
    if (!this.cameraOn || !this.videoSender) return;
    const track = await getCameraTrack(this.options.getPreferences());
    const old = this.cameraTrack;
    this.cameraTrack = track;
    this.localStream?.addTrack(track);
    if (!this.screenTrack) await this.videoSender.replaceTrack(track);
    if (old) {
      old.stop();
      this.localStream?.removeTrack(old);
    }
    this.emit('media', undefined);
  }

  async startScreenShare(): Promise<void> {
    const sender = this.videoSender;
    if (!sender || this.screenTrack || this.isEnded) return;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported by this browser.');
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
    const track = display.getVideoTracks()[0];
    if (!track) return;
    if (this.isEnded) {
      track.stop();
      return;
    }
    track.contentHint = 'detail';
    track.addEventListener('ended', () => void this.stopScreenShare());
    await sender.replaceTrack(track);
    this.screenTrack = track;
    this.screenSharing = true;
    this.emit('media', undefined);
    this.emit('controls', undefined);
  }

  async stopScreenShare(): Promise<void> {
    const track = this.screenTrack;
    if (!track) return;
    this.screenTrack = null;
    this.screenSharing = false;
    track.stop();
    if (this.videoSender && !this.isEnded) {
      await this.videoSender.replaceTrack(this.cameraOn ? this.cameraTrack : null).catch(() => undefined);
    }
    this.emit('media', undefined);
    this.emit('controls', undefined);
  }

  toggleHold(): boolean {
    if (!this.session || this.status !== 'active') return false;
    if (!this.session.isReadyToReOffer()) {
      this.emit('notice', 'Please wait — the call is still being updated.');
      return false;
    }
    return this.localHold ? this.session.unhold() : this.session.hold();
  }

  sendDtmf(tones: string): void {
    if (!this.session || this.status !== 'active') return;
    this.session.sendDTMF(tones, {
      transportType: JsSIP.C.DTMF_TRANSPORT.RFC2833,
      duration: 160,
      interToneGap: 80,
    });
  }

  /** Blind transfer (SIP REFER). Resolves when the transfer target was accepted. */
  transfer(target: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.session || this.status !== 'active') {
        reject(new Error('Only an active call can be transferred.'));
        return;
      }
      this.transferring = true;
      this.emit('controls', undefined);
      const fail = (reason: string) => {
        this.transferring = false;
        this.transferPending = false;
        this.emit('controls', undefined);
        reject(new Error(reason));
      };
      this.session.refer(target, {
        eventHandlers: {
          requestSucceeded: () => {
            this.transferPending = true;
          },
          requestFailed: (e: { response?: IncomingResponse; cause?: string }) =>
            fail(e.response ? `${e.response.status_code} ${e.response.reason_phrase}` : (e.cause ?? 'Transfer rejected')),
          accepted: () => {
            this.transferred = true;
            this.transferring = false;
            resolve();
            // Asterisk normally hangs up the transferred leg; make sure we do too.
            window.setTimeout(() => this.hangup(), 1500);
          },
          failed: (e: { status_line?: { status_code: number; reason_phrase: string } }) =>
            fail(e.status_line ? `Transfer failed: ${e.status_line.status_code} ${e.status_line.reason_phrase}` : 'Transfer failed'),
        },
      });
    });
  }

  async getStats(): Promise<CallStats | undefined> {
    if (!this.statsSampler || this.isEnded) return undefined;
    try {
      return await this.statsSampler.sample();
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private setStatus(status: CallStatus): void {
    if (this.status === status || this.status === 'ended') return;
    this.status = status;
    this.emit('status', status);
  }

  private attachPeerConnection(pc: RTCPeerConnection): void {
    this.pc = pc;
    this.statsSampler = new StatsSampler(pc);
    pc.addEventListener('track', (event) => {
      const track = event.track;
      if (!this.remoteStream.getTracks().includes(track)) {
        // One audio + one video track per call: replace a previous track of the same kind.
        for (const old of this.remoteStream.getTracks()) {
          if (old.kind === track.kind) this.remoteStream.removeTrack(old);
        }
        this.remoteStream.addTrack(track);
      }
      track.addEventListener('unmute', () => this.emit('media', undefined));
      this.emit('media', undefined);
    });
    pc.addEventListener('connectionstatechange', () => {
      this.mediaState = pc.connectionState;
      window.clearTimeout(this.mediaFailTimer);
      if (pc.connectionState === 'failed') {
        this.emit('notice', 'The media connection failed (ICE). Check EXTERNAL_IP and that the RTP ports are reachable.');
        this.mediaFailTimer = window.setTimeout(() => this.hangup(), 4000);
      } else if (pc.connectionState === 'disconnected') {
        this.emit('notice', 'Network interrupted — trying to recover…');
      }
      this.emit('controls', undefined);
    });
  }

  /**
   * JsSIP waits for ICE gathering to complete before sending the SDP. That can
   * take many seconds with unreachable STUN/TURN servers or VPN adapters, so
   * cap it: host candidates arrive almost immediately.
   */
  private onIceCandidate({ candidate, ready }: IceCandidateEvent): void {
    if (this.iceRound !== ready) {
      this.iceRound = ready;
      window.clearTimeout(this.iceTimer);
      const wait = this.options.iceServers.length ? 1500 : 600;
      this.iceTimer = window.setTimeout(ready, wait);
    }
    if (candidate.type === 'relay') {
      window.clearTimeout(this.iceTimer);
      this.iceTimer = window.setTimeout(ready, 100);
    }
  }

  private onAnswered(): void {
    if (this.status === 'active' || this.isEnded) return;
    this.answeredAt = Date.now();
    this.locateVideoSender();
    if (this.placeholderTrack && this.videoSender) {
      const placeholder = this.placeholderTrack;
      this.placeholderTrack = null;
      void this.videoSender.replaceTrack(null).finally(() => {
        placeholder.stop();
        this.localStream?.removeTrack(placeholder);
      });
    }
    this.setStatus('active');
    this.emit('media', undefined);
    this.emit('controls', undefined);
  }

  private locateVideoSender(): void {
    if (!this.pc) return;
    const transceiver = this.pc
      .getTransceivers()
      .find((t) => t.receiver.track?.kind === 'video' && t.currentDirection !== 'stopped' && (t.direction === 'sendrecv' || t.direction === 'sendonly'));
    this.videoSender = transceiver?.sender;
  }

  private onHold(originator: string, held: boolean): void {
    if (originator === 'local') this.localHold = held;
    else this.remoteHold = held;
    this.emit('controls', undefined);
  }

  private syncMute(): void {
    this.micMuted = Boolean(this.session?.isMuted().audio);
    this.emit('controls', undefined);
  }

  private finish(e: Pick<EndEvent, 'cause'> & { originator: string; message?: unknown }): void {
    if (this.isEnded) return;
    window.clearTimeout(this.iceTimer);
    window.clearTimeout(this.mediaFailTimer);
    const response = e.message as Partial<IncomingResponse> | undefined;
    const code = typeof response?.status_code === 'number' ? response.status_code : undefined;
    const unanswered = !this.answeredAt;
    this.endInfo = {
      reason: this.transferred || this.transferPending ? 'Call transferred' : describeEnd(e.cause, code, e.originator, this.direction, unanswered),
      originator: e.originator as CallEnd['originator'],
      code,
      unanswered,
      error: isErrorCause(e.cause),
    };
    this.endedAt = Date.now();
    this.status = 'ended';
    this.screenTrack?.stop();
    this.placeholderTrack?.stop();
    this.cameraTrack?.stop();
    stopStream(this.localStream);
    this.emit('status', 'ended');
    this.emit('ended', this.endInfo);
    this.removeAllListeners();
  }
}

const ERROR_CAUSES = new Set<string>([
  JsSIP.C.causes.CONNECTION_ERROR,
  JsSIP.C.causes.REQUEST_TIMEOUT,
  JsSIP.C.causes.INTERNAL_ERROR,
  JsSIP.C.causes.INCOMPATIBLE_SDP,
  JsSIP.C.causes.MISSING_SDP,
  JsSIP.C.causes.WEBRTC_ERROR,
  JsSIP.C.causes.BAD_MEDIA_DESCRIPTION,
  JsSIP.C.causes.RTP_TIMEOUT,
  JsSIP.C.causes.DIALOG_ERROR,
  JsSIP.C.causes.NO_ACK,
  JsSIP.C.causes.AUTHENTICATION_ERROR,
  JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS,
]);

function isErrorCause(cause: string): boolean {
  return ERROR_CAUSES.has(cause);
}

function describeEnd(cause: string, code: number | undefined, originator: string, direction: CallDirection, unanswered: boolean): string {
  const C = JsSIP.C.causes;
  switch (cause) {
    case C.BYE:
      return originator === 'local' ? 'You ended the call' : 'Call ended';
    case C.CANCELED:
      return direction === 'incoming' ? 'Missed call' : 'Call cancelled';
    case C.BUSY:
      return direction === 'incoming' ? 'Call declined' : 'Busy';
    case C.REJECTED:
      return direction === 'incoming' ? 'Call declined' : 'Call rejected';
    case C.NOT_FOUND:
      return 'Number not found';
    case C.UNAVAILABLE:
      return code === 480 && direction === 'outgoing' ? 'Not available' : 'Unavailable';
    case C.NO_ANSWER:
      return direction === 'incoming' ? 'Missed call' : 'No answer';
    case C.ADDRESS_INCOMPLETE:
      return 'Incomplete number';
    case C.INCOMPATIBLE_SDP:
    case C.BAD_MEDIA_DESCRIPTION:
      return 'Incompatible media';
    case C.CONNECTION_ERROR:
      return 'Connection lost';
    case C.REQUEST_TIMEOUT:
      return 'Request timed out';
    case C.RTP_TIMEOUT:
      return 'Media timed out';
    case C.USER_DENIED_MEDIA_ACCESS:
      return 'Microphone/camera access denied';
    case C.AUTHENTICATION_ERROR:
      return 'Not authorised';
    case C.WEBRTC_ERROR:
      return 'Media negotiation failed';
    case C.SIP_FAILURE_CODE:
      if (code === 503) return 'Service unavailable';
      if (code === 486) return 'Busy';
      return code ? `Call failed (${code})` : 'Call failed';
    default:
      return unanswered ? `Call failed (${cause})` : 'Call ended';
  }
}
