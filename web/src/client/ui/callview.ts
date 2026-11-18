import type { DirectoryEntry } from '../config';
import { applyOutputDevice } from '../media/devices';
import type { CallStats } from '../media/stats';
import type { TonePlayer } from '../media/tones';
import type { Call } from '../sip/call';
import { formatBitrate, formatDuration } from '../util/format';
import { avatar } from './avatar';
import { keypad } from './dialpad';
import { clear, h, toggle } from './dom';
import { icon, type IconName } from './icons';
import { toast } from './toast';

export interface CallViewOptions {
  tones: TonePlayer;
  directory: DirectoryEntry[];
  outputDevice: () => string;
  transferUri: (number: string) => string;
  onClosed: () => void;
}

interface Control {
  el: HTMLButtonElement;
  set(state: { active?: boolean; disabled?: boolean; icon?: IconName; label?: string; title?: string }): void;
}

function control(iconName: IconName, label: string, onClick: () => void, extraClass = ''): Control {
  const iconSlot = h('span', { class: 'control-icon' }, icon(iconName, 22));
  const labelEl = h('span', { class: 'control-label' }, label);
  const el = h('button', { class: `control ${extraClass}`.trim(), type: 'button', 'aria-label': label, title: label, onclick: onClick }, iconSlot, labelEl);
  let currentIcon = iconName;
  return {
    el,
    set({ active, disabled, icon: nextIcon, label: nextLabel, title }) {
      if (active !== undefined) {
        toggle(el, 'active', active);
        el.setAttribute('aria-pressed', String(active));
      }
      if (disabled !== undefined) el.disabled = disabled;
      if (nextIcon && nextIcon !== currentIcon) {
        currentIcon = nextIcon;
        iconSlot.replaceChildren(icon(nextIcon, 22));
      }
      if (nextLabel) {
        labelEl.textContent = nextLabel;
        el.setAttribute('aria-label', nextLabel);
      }
      if (title || nextLabel) el.title = title ?? nextLabel ?? '';
    },
  };
}

type PanelName = 'stats' | 'dtmf' | 'transfer';

/** Full in-call experience: remote/local video, status, controls, DTMF, transfer and live statistics. */
export class CallView {
  readonly el: HTMLElement;
  private readonly remoteVideo: HTMLVideoElement;
  private readonly remoteAudio: HTMLAudioElement;
  private readonly localVideo: HTMLVideoElement;
  private readonly localPip: HTMLElement;
  private readonly pipLabel: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly placeholderStatus: HTMLElement;
  private readonly badges: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly qualityEl: HTMLElement;
  private readonly speakingRing: HTMLElement;
  private readonly endOverlay: HTMLElement;
  private readonly panels: Record<PanelName, HTMLElement>;
  private readonly statsBody: HTMLElement;
  private readonly dtmfDisplay: HTMLElement;
  private readonly controls: Record<'mute' | 'camera' | 'share' | 'hold' | 'keypad' | 'transfer' | 'stats' | 'fullscreen' | 'hangup', Control>;

  private openPanel: PanelName | undefined;
  private timer: number | undefined;
  private statsTimer: number | undefined;
  private lastStats: CallStats | undefined;
  private remoteVideoFlowing = false;
  private remoteTrackKey = '';
  private localTrackId = '';
  private pipCorner = 0;
  private closed = false;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly onFullscreenChange = () => this.syncControls();
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKey(event);

  constructor(
    private readonly call: Call,
    private readonly options: CallViewOptions,
  ) {
    this.remoteVideo = h('video', { class: 'remote-video', autoplay: true, playsInline: true, muted: true });
    this.remoteAudio = h('audio', { class: 'remote-audio', autoplay: true });
    this.remoteVideo.addEventListener('resize', () => {
      if (this.remoteVideo.videoWidth > 0) this.setRemoteVideoFlowing(true);
    });
    this.localVideo = h('video', { class: 'local-video', autoplay: true, playsInline: true, muted: true });
    this.pipLabel = h('span', { class: 'pip-label' }, 'You');
    this.localPip = h(
      'div',
      { class: 'local-pip', title: 'Click to move', onclick: () => this.movePip() },
      this.localVideo,
      this.pipLabel,
    );

    this.statusText = h('span', { class: 'call-status' });
    this.placeholderStatus = h('p', { class: 'placeholder-status' });
    this.badges = h('div', { class: 'call-badges' });
    this.qualityEl = h('span', { class: 'quality', title: 'Connection quality' }, h('i'), h('i'), h('i'), h('i'));
    this.banner = h('div', { class: 'call-banner', hidden: true });
    this.speakingRing = h('div', { class: 'speaking-ring' });
    this.endOverlay = h('div', { class: 'end-overlay', hidden: true });

    // Panels -----------------------------------------------------------------
    this.statsBody = h('dl', { class: 'stats-grid' });
    this.dtmfDisplay = h('div', { class: 'dtmf-display', 'aria-live': 'polite' });
    const transferInput = h('input', {
      class: 'input',
      type: 'tel',
      placeholder: 'Extension or number',
      list: 'transfer-directory',
      'aria-label': 'Transfer to',
    });
    const transferError = h('p', { class: 'form-error', hidden: true });
    const transferForm = h(
      'form',
      { class: 'transfer-form' },
      transferInput,
      h(
        'datalist',
        { id: 'transfer-directory' },
        ...options.directory.map((u) => h('option', { value: u.extension }, u.name)),
      ),
      transferError,
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, icon('phone-forward', 18), 'Transfer now'),
    );
    transferForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const target = transferInput.value.trim();
      if (!/^[0-9*#+]+$/.test(target)) {
        transferError.textContent = 'Enter an extension or number.';
        transferError.hidden = false;
        return;
      }
      transferError.hidden = true;
      this.call
        .transfer(this.options.transferUri(target))
        .then(() => toast(`Call transferred to ${target}`, 'success'))
        .catch((error: Error) => {
          transferError.textContent = error.message;
          transferError.hidden = false;
        });
    });

    this.panels = {
      stats: this.panel('Call statistics', this.statsBody),
      dtmf: this.panel(
        'Keypad',
        this.dtmfDisplay,
        keypad((key) => {
          this.options.tones.playDtmf(key);
          this.call.sendDtmf(key);
          this.dtmfDisplay.textContent = (this.dtmfDisplay.textContent + key).slice(-24);
        }),
      ),
      transfer: this.panel('Transfer call', h('p', { class: 'muted small' }, 'Blind transfer: the other party is connected to the new number and you leave the call.'), transferForm),
    };

    // Controls ---------------------------------------------------------------
    this.controls = {
      mute: control('mic', 'Mute', () => this.call.toggleMute()),
      camera: control('video', 'Stop video', () => void this.toggleCamera()),
      share: control('screen-share', 'Share screen', () => void this.toggleShare()),
      hold: control('pause', 'Hold', () => this.call.toggleHold()),
      keypad: control('keypad', 'Keypad', () => this.togglePanel('dtmf')),
      transfer: control('phone-forward', 'Transfer', () => {
        this.togglePanel('transfer');
        if (this.openPanel === 'transfer') queueMicrotask(() => transferInput.focus());
      }),
      stats: control('activity', 'Stats', () => this.togglePanel('stats')),
      fullscreen: control('maximize', 'Full screen', () => void this.toggleFullscreen()),
      hangup: control('hangup', 'End call', () => this.call.hangup(), 'control-hangup'),
    };

    const placeholderAvatar = avatar(call.remoteName, call.remoteNumber, 'xl');
    this.el = h(
      'section',
      { class: 'call-view', 'aria-label': `Call with ${call.remoteName}` },
      h(
        'div',
        { class: 'call-stage' },
        this.remoteVideo,
        this.remoteAudio,
        h(
          'div',
          { class: 'remote-placeholder' },
          h('div', { class: 'placeholder-avatar' }, this.speakingRing, placeholderAvatar),
          h('h2', { class: 'placeholder-name' }, call.remoteName),
          call.remoteName !== call.remoteNumber ? h('p', { class: 'placeholder-number muted' }, call.remoteNumber) : null,
          this.placeholderStatus,
        ),
        h(
          'header',
          { class: 'call-header' },
          h(
            'div',
            { class: 'call-identity' },
            h('div', { class: 'call-name' }, call.remoteName),
            h('div', { class: 'call-sub' }, this.statusText),
          ),
          h('div', { class: 'call-header-right' }, this.badges, this.qualityEl),
        ),
        this.banner,
        this.localPip,
        ...Object.values(this.panels),
        this.endOverlay,
      ),
      h(
        'footer',
        { class: 'call-controls' },
        h('div', { class: 'controls-group' }, this.controls.mute.el, this.controls.camera.el, this.controls.share.el, this.controls.hold.el),
        h('div', { class: 'controls-group' }, this.controls.hangup.el),
        h(
          'div',
          { class: 'controls-group' },
          this.controls.keypad.el,
          this.controls.transfer.el,
          this.controls.stats.el,
          this.controls.fullscreen.el,
        ),
      ),
    );

    this.unsubscribe.push(
      call.on('status', () => this.syncStatus()),
      call.on('media', () => this.syncMedia()),
      call.on('controls', () => this.syncControls()),
      call.on('notice', (message) => toast(message, 'warning')),
      call.on('ended', () => this.showEnded()),
    );
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('keydown', this.onKeyDown);

    this.timer = window.setInterval(() => this.syncStatusText(), 1000);
    this.statsTimer = window.setInterval(() => void this.pollStats(), 1000);
    void applyOutputDevice(this.remoteAudio, options.outputDevice());

    this.syncStatus();
    this.syncMedia();
    this.syncControls();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.timer);
    window.clearInterval(this.statsTimer);
    this.options.tones.stopLoop();
    this.unsubscribe.forEach((fn) => fn());
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('keydown', this.onKeyDown);
    if (document.fullscreenElement === this.el) void document.exitFullscreen().catch(() => undefined);
    this.remoteVideo.srcObject = null;
    this.remoteAudio.srcObject = null;
    this.localVideo.srcObject = null;
    this.el.remove();
  }

  setOutputDevice(deviceId: string): void {
    void applyOutputDevice(this.remoteAudio, deviceId);
  }

  // ---------------------------------------------------------------------------

  private panel(title: string, ...content: Node[]): HTMLElement {
    return h(
      'aside',
      { class: 'call-panel', hidden: true },
      h(
        'div',
        { class: 'call-panel-header' },
        h('h3', {}, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.togglePanel(undefined) }, icon('x', 18)),
      ),
      ...content,
    );
  }

  private togglePanel(name: PanelName | undefined): void {
    this.openPanel = name === this.openPanel ? undefined : name;
    for (const [key, panel] of Object.entries(this.panels) as Array<[PanelName, HTMLElement]>) {
      panel.hidden = key !== this.openPanel;
    }
    if (this.openPanel === 'stats') this.renderStats();
    this.syncControls();
  }

  private syncStatus(): void {
    const { call } = this;
    this.el.dataset.status = call.status;
    const tones = this.options.tones;
    if (call.status === 'ringing' && call.direction === 'outgoing' && !call.earlyMedia) tones.startRingback();
    else tones.stopLoop();
    this.syncStatusText();
    this.syncControls();
  }

  private syncStatusText(): void {
    const { call } = this;
    let text: string;
    switch (call.status) {
      case 'calling':
        text = 'Calling…';
        break;
      case 'ringing':
        text = call.earlyMedia ? 'Connecting…' : 'Ringing…';
        break;
      case 'incoming':
      case 'connecting':
        text = 'Connecting…';
        break;
      case 'active':
        text = call.localHold ? `On hold · ${formatDuration(call.durationSeconds)}` : formatDuration(call.durationSeconds);
        break;
      default:
        text = call.endInfo?.reason ?? 'Call ended';
    }
    this.statusText.textContent = text;
    this.placeholderStatus.textContent =
      call.status === 'active' && call.videoCall && !this.remoteVideoFlowing ? `${text} · camera off` : text;
  }

  private syncMedia(): void {
    const { call } = this;
    // Remote media: separate elements so audio keeps playing whatever happens to the video.
    const audioTracks = call.remoteStream.getAudioTracks();
    const videoTracks = call.remoteStream.getVideoTracks();
    const key = [...audioTracks, ...videoTracks].map((t) => t.id).join(',');
    if (key !== this.remoteTrackKey) {
      this.remoteTrackKey = key;
      this.remoteAudio.srcObject = audioTracks.length ? new MediaStream(audioTracks) : null;
      this.remoteVideo.srcObject = videoTracks.length ? new MediaStream(videoTracks) : null;
      this.remoteAudio.play().catch(() => undefined);
      this.remoteVideo.play().catch(() => undefined);
    }

    const localTrack = call.localVideoTrack;
    const localId = localTrack?.id ?? '';
    if (localId !== this.localTrackId) {
      this.localTrackId = localId;
      this.localVideo.srcObject = localTrack ? new MediaStream([localTrack]) : null;
      if (localTrack) this.localVideo.play().catch(() => undefined);
    }
    toggle(this.localPip, 'visible', Boolean(localTrack) && call.status !== 'ended');
    toggle(this.localPip, 'mirrored', Boolean(localTrack) && !call.screenSharing);
    this.pipLabel.textContent = call.screenSharing ? 'Your screen' : 'You';
    this.syncControls();
  }

  private setRemoteVideoFlowing(flowing: boolean): void {
    if (flowing === this.remoteVideoFlowing) return;
    this.remoteVideoFlowing = flowing;
    toggle(this.el, 'has-remote-video', flowing);
    this.syncStatusText();
  }

  private syncControls(): void {
    const { call, controls } = this;
    const active = call.status === 'active';
    const ended = call.status === 'ended';

    controls.mute.set({ active: call.micMuted, icon: call.micMuted ? 'mic-off' : 'mic', label: call.micMuted ? 'Unmute' : 'Mute', disabled: ended });
    controls.camera.set({
      active: call.canSendVideo && !call.cameraOn,
      icon: call.cameraOn ? 'video' : 'video-off',
      label: call.cameraOn ? 'Stop video' : 'Start video',
      disabled: ended || !call.canSendVideo,
      title: call.canSendVideo ? undefined : 'Video is not available in an audio call',
    });
    controls.share.set({
      active: call.screenSharing,
      label: call.screenSharing ? 'Stop sharing' : 'Share screen',
      disabled: !active || !call.canSendVideo || !navigator.mediaDevices?.getDisplayMedia,
      title: call.canSendVideo ? undefined : 'Screen sharing needs a video call',
    });
    controls.hold.set({ active: call.localHold, icon: call.localHold ? 'play' : 'pause', label: call.localHold ? 'Resume' : 'Hold', disabled: !active });
    controls.keypad.set({ active: this.openPanel === 'dtmf', disabled: !active });
    controls.transfer.set({ active: this.openPanel === 'transfer', disabled: !active || call.transferring });
    controls.stats.set({ active: this.openPanel === 'stats', disabled: ended });
    const fullscreen = document.fullscreenElement === this.el;
    controls.fullscreen.set({ active: fullscreen, icon: fullscreen ? 'minimize' : 'maximize', label: fullscreen ? 'Exit full screen' : 'Full screen', disabled: !document.fullscreenEnabled });
    controls.hangup.set({ disabled: ended });

    // Badges and banners
    clear(this.badges);
    if (active) this.badges.append(h('span', { class: 'badge badge-secure', title: 'Media encrypted with DTLS-SRTP' }, icon('lock', 12), 'Encrypted'));
    if (call.videoCall) this.badges.append(h('span', { class: 'badge' }, icon('video', 12), 'Video'));

    let banner = '';
    if (call.localHold) banner = 'Call on hold — the other party hears music.';
    else if (call.remoteHold) banner = 'You have been put on hold.';
    else if (call.mediaState === 'disconnected') banner = 'Network interrupted — reconnecting…';
    else if (call.micMuted && active) banner = 'Your microphone is muted.';
    this.banner.textContent = banner;
    this.banner.hidden = !banner;
    this.syncStatusText();
  }

  private async toggleCamera(): Promise<void> {
    try {
      await this.call.setCamera(!this.call.cameraOn);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  private async toggleShare(): Promise<void> {
    try {
      if (this.call.screenSharing) await this.call.stopScreenShare();
      else await this.call.startScreenShare();
    } catch (error) {
      if ((error as { name?: string }).name !== 'NotAllowedError') toast((error as Error).message, 'error');
    }
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.el.requestFullscreen();
    } catch {
      // not allowed — ignore
    }
  }

  private movePip(): void {
    this.pipCorner = (this.pipCorner + 1) % 4;
    this.localPip.dataset.corner = String(this.pipCorner);
  }

  private async pollStats(): Promise<void> {
    if (this.call.status !== 'active') return;
    const stats = await this.call.getStats();
    if (!stats || this.closed) return;
    this.lastStats = stats;
    if (this.call.remoteStream.getVideoTracks().length) this.setRemoteVideoFlowing(stats.receivingVideo);
    // Reflect the media state in the DOM (handy for debugging and end-to-end tests).
    this.el.dataset.audioRx = String(stats.receivingAudio);
    this.el.dataset.videoRx = String(stats.receivingVideo);
    this.el.dataset.audioCodec = stats.audio.codec ?? '';
    this.el.dataset.videoCodec = stats.video.codec ?? '';
    this.qualityEl.dataset.level = String(stats.quality);
    this.qualityEl.title = ['No media', 'Poor', 'Fair', 'Good', 'Excellent'][stats.quality] + ' connection';
    const level = stats.audio.level ?? 0;
    this.speakingRing.style.setProperty('--level', String(Math.min(1, level * 4)));
    if (this.openPanel === 'stats') this.renderStats();
  }

  private renderStats(): void {
    const s = this.lastStats;
    clear(this.statsBody);
    if (!s) {
      this.statsBody.append(h('div', { class: 'muted' }, 'Collecting statistics…'));
      return;
    }
    const pct = (v?: number) => (v === undefined ? '—' : `${v.toFixed(1)} %`);
    const res = (w?: number, hgt?: number, fps?: number) => (w && hgt ? `${w}×${hgt}${fps ? ` @ ${Math.round(fps)} fps` : ''}` : '—');
    const rows: Array<[string, string]> = [
      ['Audio codec', s.audio.codec ?? '—'],
      ['Audio in / out', `${formatBitrate(s.audio.bitrateIn)} / ${formatBitrate(s.audio.bitrateOut)}`],
      ['Audio loss · jitter', `${pct(s.audio.packetsLostPct)} · ${s.audio.jitterMs ?? '—'} ms`],
    ];
    if (this.call.videoCall) {
      rows.push(
        ['Video codec', s.video.codec ?? '—'],
        ['Receiving', res(s.video.width, s.video.height, s.video.fps)],
        ['Sending', res(s.video.sendWidth, s.video.sendHeight, s.video.sendFps)],
        ['Video in / out', `${formatBitrate(s.video.bitrateIn)} / ${formatBitrate(s.video.bitrateOut)}`],
        ['Video loss', pct(s.video.packetsLostPct)],
      );
    }
    rows.push(
      ['Round trip', s.rttMs !== undefined ? `${s.rttMs} ms` : '—'],
      ['Transport', s.transport ?? '—'],
      ['Local', s.localCandidate ?? '—'],
      ['Remote', s.remoteCandidate ?? '—'],
      ['Encryption', s.dtlsState === 'connected' ? `DTLS-SRTP${s.srtpCipher ? ` (${s.srtpCipher})` : ''}` : (s.dtlsState ?? '—')],
    );
    for (const [label, value] of rows) this.statsBody.append(h('dt', {}, label), h('dd', {}, value));
  }

  private handleKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.openPanel === 'dtmf' && /^[0-9*#]$/.test(event.key)) {
      this.panels.dtmf.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(event.key)}"]`)?.click();
      return;
    }
    switch (event.key.toLowerCase()) {
      case 'm':
        this.call.toggleMute();
        break;
      case 'v':
        if (this.call.canSendVideo) void this.toggleCamera();
        break;
      case 'escape':
        if (this.openPanel) this.togglePanel(undefined);
        break;
    }
  }

  private showEnded(): void {
    const { call } = this;
    const info = call.endInfo;
    this.options.tones.stopLoop();
    if (info && (info.code === 486 || info.code === 600)) this.options.tones.playBusy();
    else this.options.tones.playHangup();
    this.syncMedia();
    this.syncControls();
    clear(this.endOverlay);
    this.endOverlay.append(
      h('div', { class: `end-card${info?.error ? ' error' : ''}` },
        icon(info?.error ? 'alert' : 'hangup', 28),
        h('h3', {}, info?.reason ?? 'Call ended'),
        call.answeredAt ? h('p', { class: 'muted' }, `Duration ${formatDuration(call.durationSeconds)}`) : null,
      ),
    );
    this.endOverlay.hidden = false;
    window.clearInterval(this.statsTimer);
    window.setTimeout(() => this.options.onClosed(), info?.error ? 4000 : 2200);
  }
}
