import { createElement } from 'react';

export const IMVIA_AUTHOR_NAME = '青木';
export const IMVIA_AUTHOR_URL = 'https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b';

export function DeveloperAttribution() {
  const ariaLabel = `访问开发者${IMVIA_AUTHOR_NAME}的小红书主页`;

  return createElement(
    'a',
    {
      className: 'developer-attribution',
      href: IMVIA_AUTHOR_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': ariaLabel,
    },
    createElement('span', null, '开发者 · '),
    createElement('strong', null, IMVIA_AUTHOR_NAME),
  );
}
