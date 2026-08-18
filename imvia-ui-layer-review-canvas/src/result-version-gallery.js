import { createElement } from 'react';
import { resolveWorkbenchUrl } from './mcp-workbench-host.js';

function versionLabel(index) {
  return index === 0 ? '原始 PNG' : `精修版本 ${index}`;
}

export function ResultVersionGallery({ history = [], nodeName = '拆分结果' }) {
  const versions = history.filter((result) => result?.image?.url);
  if (versions.length < 2) return null;
  const currentIndex = versions.length - 1;

  return createElement('section', {
    className: 'result-version-gallery',
    'aria-label': `${nodeName} PNG 版本`,
  }, versions.map((result, index) => {
    const current = index === currentIndex;
    const label = versionLabel(index);
    const imageName = result.image.name || `${nodeName}-${index + 1}.png`;
    return createElement('article', {
      className: `result-version-card${current ? ' result-version-card--current' : ''}`,
      key: result.job?.id || `${imageName}-${index}`,
      ...(current ? { 'aria-current': 'true' } : {}),
    }, [
      createElement('header', { key: 'header' }, [
        createElement('strong', { key: 'label' }, label),
        current ? createElement('span', { key: 'current' }, '当前版本') : null,
      ]),
      createElement('div', { className: 'result-version-card__preview', key: 'preview' },
        createElement('img', {
          src: resolveWorkbenchUrl(result.image.url),
          alt: `${nodeName} ${label}`,
          draggable: false,
        })),
      createElement('a', {
        className: 'result-version-card__download',
        href: resolveWorkbenchUrl(result.image.url),
        download: imageName,
        key: 'download',
      }, `下载 ${label}`),
    ]);
  }));
}
