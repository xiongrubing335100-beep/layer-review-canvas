export function documentNavigationItems(documents, activeImageId) {
  return (Array.isArray(documents) ? documents : []).map((document, index) => ({
    imageId: document.imageId,
    label: document.sourceName || `图片 ${index + 1}`,
    mode: document.documentMode === 'poster' ? 'poster' : 'ui',
    active: document.imageId === activeImageId,
  }));
}
