import type { Account, Preferences, VideoQuality } from '../config';
import { audioConstraints, describeMediaError, listDevices, stopStream, supportsOutputSelection, videoConstraints } from '../media/devices';
import type { TonePlayer } from '../media/tones';
import { h } from './dom';
import { icon } from './icons';

/** Device selection with live microphone meter and camera preview. */
export class SettingsModal {
  readonly el: HTMLElement;
  private draft: Preferences;
  private labelsRefreshed = false;
  private saved = false;
  private previewStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private meterFrame = 0;
  private readonly micSelect = h('select', { class: 'input', id: 'set-mic' });
  private readonly camSelect = h('select', { class: 'input', id: 'set-cam' });
  private readonly speakerSelect = h('select', { class: 'input', id: 'set-speaker' });
  private readonly qualitySelect: HTMLSelectElement;
  private readonly meter = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));
  private readonly preview = h('video', { class: 'settings-preview', autoplay: true, playsInline: true, muted: true });
  private readonly previewNote = h('p', { class: 'muted small preview-note' });
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.close();
  };

  constructor(
    private readonly current: Preferences,
    private readonly account: Account,
    private readonly registration: () => string,
    private readonly tones: TonePlayer,
    private readonly onSave: (preferences: Preferences) => void,
    private readonly onClose: () => void,
    private readonly inCall: boolean,
  ) {
    this.draft = { ...current };
    this.qualitySelect = h(
      'select',
      { class: 'input', id: 'set-quality' },
      ...(['360p', '720p', '1080p'] as VideoQuality[]).map((q) => h('option', { value: q, selected: q === current.videoQuality }, q === '720p' ? '720p HD (recommended)' : q === '1080p' ? '1080p Full HD' : '360p (low bandwidth)')),
    );

    const checkbox = (key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl' | 'desktopNotifications', label: string) =>
      h(
        'label',
        { class: 'checkbox' },
        h('input', {
          type: 'checkbox',
          checked: this.draft[key],
          onchange: (e: Event) => {
            this.draft[key] = (e.target as HTMLInputElement).checked;
            if (key !== 'desktopNotifications') void this.startPreview();
            if (key === 'desktopNotifications' && this.draft[key] && 'Notification' in window && Notification.permission === 'default') {
              void Notification.requestPermission();
            }
          },
        }),
        h('span', {}, label),
      );

    const volume = h('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(this.draft.ringtoneVolume),
      class: 'range',
      oninput: (e: Event) => {
        this.draft.ringtoneVolume = Number((e.target as HTMLInputElement).value);
        this.tones.setVolume(this.draft.ringtoneVolume);
      },
    });

    this.micSelect.addEventListener('change', () => {
      this.draft.audioInput = this.micSelect.value;
      void this.startPreview();
    });
    this.camSelect.addEventListener('change', () => {
      this.draft.videoInput = this.camSelect.value;
      void this.startPreview();
    });
    this.qualitySelect.addEventListener('change', () => {
      this.draft.videoQuality = this.qualitySelect.value as VideoQuality;
      void this.startPreview();
    });
    this.speakerSelect.addEventListener('change', () => {
      this.draft.audioOutput = this.speakerSelect.value;
    });

    const testSpeaker = h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onclick: async () => {
          await this.tones.setOutputDevice(this.draft.audioOutput);
          this.tones.unlock();
          this.tones.startRingtone();
          window.setTimeout(() => this.tones.stopLoop(), 1400);
        },
      },
      icon('volume', 16),
      'Test',
    );

    this.el = h(
      'div',
      { class: 'modal-backdrop', onclick: (e: Event) => e.target === this.el && this.close() },
      h(
        'div',
        { class: 'modal settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
        h('header', { class: 'modal-header' }, h('h2', { id: 'settings-title' }, 'Settings'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.close() }, icon('x', 20))),
        h(
          'div',
          { class: 'modal-body settings-grid' },
          h(
            'section',
            {},
            h('h3', {}, 'Audio'),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Microphone'), this.micSelect),
            this.meter,
            h(
              'label',
              { class: 'field' },
              h('span', { class: 'field-label' }, 'Speaker'),
              h('div', { class: 'input-row' }, this.speakerSelect, testSpeaker),
            ),
            checkbox('echoCancellation', 'Echo cancellation'),
            checkbox('noiseSuppression', 'Noise suppression'),
            checkbox('autoGainControl', 'Automatic gain control'),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Ringtone volume'), volume),
          ),
          h(
            'section',
            {},
            h('h3', {}, 'Video'),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Camera'), this.camSelect),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sending quality'), this.qualitySelect),
            h('div', { class: 'preview-wrap' }, this.preview),
            this.previewNote,
            h('h3', {}, 'Notifications'),
            checkbox('desktopNotifications', 'Desktop notification for incoming calls'),
          ),
          h(
            'section',
            { class: 'span-2' },
            h('h3', {}, 'Account'),
            h(
              'dl',
              { class: 'account-grid' },
              h('dt', {}, 'Extension'), h('dd', {}, this.account.extension),
              h('dt', {}, 'Name'), h('dd', {}, this.account.displayName || '—'),
              h('dt', {}, 'Server'), h('dd', { class: 'mono' }, this.account.server),
              h('dt', {}, 'SIP URI'), h('dd', { class: 'mono' }, `sip:${this.account.extension}@${this.account.domain}`),
              h('dt', {}, 'Status'), h('dd', {}, this.registration()),
            ),
          ),
        ),
        h(
          'footer',
          { class: 'modal-footer' },
          this.inCall ? h('span', { class: 'muted small' }, 'Device changes apply to your next call.') : null,
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => this.close() }, 'Cancel'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.save() }, 'Save'),
        ),
      ),
    );
    document.addEventListener('keydown', this.onKeyDown);
    void this.populate().then(() => this.startPreview());
  }

  private async populate(): Promise<void> {
    const devices = await listDevices();
    const fill = (select: HTMLSelectElement, list: MediaDeviceInfo[], selected: string, fallbackLabel: string) => {
      select.replaceChildren(
        h('option', { value: '' }, 'System default'),
        ...list
          .filter((d) => d.deviceId && d.deviceId !== 'default')
          .map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === selected }, d.label || `${fallbackLabel} ${i + 1}`)),
      );
    };
    fill(this.micSelect, devices.audioInputs, this.draft.audioInput, 'Microphone');
    fill(this.camSelect, devices.videoInputs, this.draft.videoInput, 'Camera');
    fill(this.speakerSelect, devices.audioOutputs, this.draft.audioOutput, 'Speaker');
    this.speakerSelect.disabled = !supportsOutputSelection();
    if (!supportsOutputSelection()) this.speakerSelect.title = 'This browser does not support choosing the output device';
  }

  private async startPreview(): Promise<void> {
    this.stopPreview();
    if (this.inCall) {
      this.previewNote.textContent = 'Preview is paused during a call.';
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(this.draft), video: videoConstraints(this.draft) });
      this.previewNote.textContent = '';
    } catch (error) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(this.draft) });
        this.previewNote.textContent = describeMediaError(error, 'camera');
      } catch (audioError) {
        this.previewNote.textContent = describeMediaError(audioError, 'microphone and camera');
        return;
      }
    }
    if (!this.el.isConnected) {
      stopStream(stream);
      return;
    }
    this.previewStream = stream;
    this.preview.srcObject = stream.getVideoTracks().length ? new MediaStream(stream.getVideoTracks()) : null;
    // Device labels are only exposed once permission was granted: refresh the lists once.
    if (!this.labelsRefreshed) {
      this.labelsRefreshed = true;
      void this.populate();
    }
    this.startMeter(stream);
  }

  private startMeter(stream: MediaStream): void {
    if (!stream.getAudioTracks().length) return;
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const fill = this.meter.firstElementChild as HTMLElement;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      fill.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
      this.meterFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  private stopPreview(): void {
    cancelAnimationFrame(this.meterFrame);
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    stopStream(this.previewStream);
    this.previewStream = null;
    this.preview.srcObject = null;
  }

  private save(): void {
    this.saved = true;
    this.onSave({ ...this.draft });
    this.close();
  }

  close(): void {
    this.stopPreview();
    this.tones.stopLoop();
    if (!this.saved) {
      this.tones.setVolume(this.current.ringtoneVolume);
      void this.tones.setOutputDevice(this.current.audioOutput);
    }
    document.removeEventListener('keydown', this.onKeyDown);
    this.el.remove();
    this.onClose();
  }
}
