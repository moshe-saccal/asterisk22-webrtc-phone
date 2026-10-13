import { h } from './dom';
import { icon, type IconName } from './icons';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

const ICON: Record<ToastKind, IconName> = { info: 'info', success: 'check', warning: 'alert', error: 'alert' };

let container: HTMLElement | undefined;

export function toast(message: string, kind: ToastKind = 'info', timeoutMs = kind === 'error' ? 8000 : 5000): void {
  if (!container) {
    container = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  const close = () => {
    item.classList.add('leaving');
    window.setTimeout(() => item.remove(), 200);
  };
  const item = h(
    'div',
    { class: `toast toast-${kind}` },
    icon(ICON[kind], 18),
    h('span', { class: 'toast-text' }, message),
    h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: close }, icon('x', 16)),
  );
  container.append(item);
  // Collapse duplicates / keep the stack short.
  while (container.children.length > 4) container.firstElementChild?.remove();
  window.setTimeout(close, timeoutMs);
}
