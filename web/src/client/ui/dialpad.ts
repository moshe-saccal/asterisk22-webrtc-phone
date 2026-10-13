import type { TonePlayer } from '../media/tones';
import { h } from './dom';
import { icon } from './icons';

export const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/** Builds a 4×3 keypad. Used by the idle dial pad and by the in-call DTMF pad. */
export function keypad(onKey: (key: string) => void, onLongZero?: () => void): HTMLElement {
  return h(
    'div',
    { class: 'keypad' },
    ...KEYS.map(([key, letters]) => {
      let pressTimer: number | undefined;
      let longPressed = false;
      const button = h(
        'button',
        { class: 'key', type: 'button', 'data-key': key, 'aria-label': key },
        h('span', { class: 'key-digit' }, key),
        h('span', { class: 'key-letters' }, letters || ' '),
      );
      if (key === '0' && onLongZero) {
        button.addEventListener('pointerdown', () => {
          longPressed = false;
          pressTimer = window.setTimeout(() => {
            longPressed = true;
            onLongZero();
          }, 600);
        });
        const cancel = () => window.clearTimeout(pressTimer);
        button.addEventListener('pointerup', cancel);
        button.addEventListener('pointerleave', cancel);
      }
      button.addEventListener('click', () => {
        if (longPressed) {
          longPressed = false;
          return;
        }
        onKey(key);
      });
      return button;
    }),
  );
}

/** The idle-screen dial pad. */
export class DialPad {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly audioButton: HTMLButtonElement;
  private readonly videoButton: HTMLButtonElement;

  constructor(
    private readonly tones: TonePlayer,
    private readonly onDial: (number: string, video: boolean) => void,
  ) {
    this.input = h('input', {
      class: 'dial-input',
      type: 'tel',
      inputmode: 'tel',
      autocomplete: 'off',
      placeholder: 'Enter a number',
      'aria-label': 'Number to dial',
      oninput: () => this.sync(),
      onkeydown: (event: Event) => {
        const e = event as KeyboardEvent;
        if (e.key === 'Enter') {
          e.preventDefault();
          this.dial(e.shiftKey);
        }
      },
    });
    const backspace = h(
      'button',
      {
        class: 'icon-btn dial-backspace',
        type: 'button',
        'aria-label': 'Delete',
        onclick: () => {
          this.input.value = this.input.value.slice(0, -1);
          this.sync();
        },
      },
      icon('backspace', 22),
    );
    this.audioButton = h(
      'button',
      { class: 'call-btn call-btn-audio', type: 'button', 'aria-label': 'Audio call', title: 'Audio call (Enter)', onclick: () => this.dial(false) },
      icon('phone', 26),
    );
    this.videoButton = h(
      'button',
      { class: 'call-btn call-btn-video', type: 'button', 'aria-label': 'Video call', title: 'Video call (Shift+Enter)', onclick: () => this.dial(true) },
      icon('video', 26),
    );

    this.el = h(
      'section',
      { class: 'dialpad', 'aria-label': 'Dial pad' },
      h('div', { class: 'dial-display' }, this.input, backspace),
      keypad(
        (key) => this.press(key),
        () => this.press('+'),
      ),
      h('div', { class: 'dial-actions' }, this.audioButton, this.videoButton),
      h('p', { class: 'dial-hint muted' }, 'Try ', h('b', {}, '600'), ' for a video echo test.'),
    );
    this.sync();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  setNumber(number: string): void {
    this.input.value = number;
    this.sync();
  }

  /** Global keyboard input while the dial pad is visible. */
  handleKey(event: KeyboardEvent): boolean {
    if (document.activeElement === this.input) return false;
    if (/^[0-9*#+]$/.test(event.key)) {
      this.press(event.key);
      return true;
    }
    if (event.key === 'Backspace') {
      this.input.value = this.input.value.slice(0, -1);
      this.sync();
      return true;
    }
    if (event.key === 'Enter' && this.input.value) {
      this.dial(event.shiftKey);
      return true;
    }
    return false;
  }

  private press(key: string): void {
    this.tones.playDtmf(key === '+' ? '0' : key);
    this.input.value += key;
    this.sync();
  }

  private dial(video: boolean): void {
    const number = this.input.value.trim();
    if (!number) {
      this.focus();
      return;
    }
    this.onDial(number, video);
  }

  private sync(): void {
    const empty = !this.input.value.trim();
    this.audioButton.disabled = empty;
    this.videoButton.disabled = empty;
  }
}
