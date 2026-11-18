import { hueFor, initials } from '../util/format';
import { h } from './dom';

export function avatar(name: string, id: string, size: 'sm' | 'md' | 'lg' | 'xl' = 'md'): HTMLElement {
  const hue = hueFor(id || name);
  return h(
    'div',
    {
      class: `avatar avatar-${size}`,
      style: `--avatar-hue: ${hue}`,
      'aria-hidden': 'true',
    },
    initials(name),
  );
}
