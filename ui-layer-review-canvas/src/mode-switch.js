import { createElement } from 'react';
import { ListChecks, Network } from 'lucide-react';

export function ModeSwitch({ value, onChange }) {
  return createElement(
    'div',
    { className: 'mode-switch', role: 'tablist', 'aria-label': '复核模式' },
    createElement(
      'button',
      {
        type: 'button',
        className: value === 'guided' ? 'mode-switch__active' : '',
        'aria-label': '框选拆分',
        'data-tooltip': '框选拆分',
        onClick: () => onChange('guided'),
      },
      createElement(ListChecks, { size: 15 }),
      createElement('span', { className: 'mode-switch__label' }, '框选拆分'),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: value === 'canvas' ? 'mode-switch__active' : '',
        'aria-label': '画布总览',
        'data-tooltip': '画布总览',
        onClick: () => onChange('canvas'),
      },
      createElement(Network, { size: 15 }),
      createElement('span', { className: 'mode-switch__label' }, '画布总览'),
    ),
  );
}
