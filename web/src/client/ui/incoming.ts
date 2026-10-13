import type { Call } from '../sip/call';
import { avatar } from './avatar';
import { h } from './dom';
import { icon } from './icons';

export interface IncomingHandlers {
  onAnswer: (video: boolean) => void;
  onDecline: () => void;
}

/** Modal shown while an incoming call is ringing. */
export class IncomingCallModal {
  readonly el: HTMLElement;

  constructor(call: Call, handlers: IncomingHandlers) {
    const kind = call.videoCall ? 'Incoming video call' : 'Incoming call';
    const buttons: HTMLElement[] = [
      h(
        'button',
        { class: 'round-btn round-btn-decline', type: 'button', 'aria-label': 'Decline', 'data-action': 'decline', onclick: handlers.onDecline },
        icon('hangup', 26),
        h('span', {}, 'Decline'),
      ),
      h(
        'button',
        { class: 'round-btn round-btn-accept', type: 'button', 'aria-label': call.videoCall ? 'Answer with audio only' : 'Answer', 'data-action': 'answer-audio', onclick: () => handlers.onAnswer(false) },
        icon('phone', 26),
        h('span', {}, call.videoCall ? 'Audio' : 'Answer'),
      ),
    ];
    if (call.videoCall) {
      buttons.push(
        h(
          'button',
          { class: 'round-btn round-btn-accept', type: 'button', 'aria-label': 'Answer with video', 'data-action': 'answer-video', onclick: () => handlers.onAnswer(true) },
          icon('video', 26),
          h('span', {}, 'Video'),
        ),
      );
    }

    this.el = h(
      'div',
      { class: 'modal-backdrop incoming-backdrop' },
      h(
        'div',
        { class: 'incoming-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'incoming-name', 'aria-describedby': 'incoming-kind' },
        h('div', { class: 'incoming-avatar' }, h('span', { class: 'pulse' }), h('span', { class: 'pulse delay' }), avatar(call.remoteName, call.remoteNumber, 'xl')),
        h('p', { id: 'incoming-kind', class: 'incoming-kind' }, icon(call.videoCall ? 'video' : 'phone', 14), kind),
        h('h2', { id: 'incoming-name' }, call.remoteName),
        call.remoteName !== call.remoteNumber ? h('p', { class: 'muted' }, call.remoteNumber) : null,
        h('div', { class: 'incoming-actions' }, ...buttons),
      ),
    );
    queueMicrotask(() => this.el.querySelector<HTMLButtonElement>('[data-action^="answer"]')?.focus());
  }

  destroy(): void {
    this.el.remove();
  }
}
