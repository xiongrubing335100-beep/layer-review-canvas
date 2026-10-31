const PREVIEW_MODES = Object.freeze({
  '#00FF00': 'poster-preview--green-key',
  '#000000': 'poster-preview--black-key',
});

/**
 * Describes a client-only keyed-preview treatment.  It deliberately keeps the
 * canonical PNG URL unchanged: this object is presentation metadata, not a
 * derived asset that could be stored or exported.
 */
export function derivePosterPreview({ candidateUrl, fillColor } = {}) {
  if (typeof candidateUrl !== 'string' || candidateUrl.length === 0) return null;
  const normalizedFill = String(fillColor || '#00FF00').toUpperCase();
  const className = PREVIEW_MODES[normalizedFill];
  if (!className) throw new TypeError('poster preview requires a #00FF00 or #000000 key');
  return {
    candidateUrl,
    fillColor: normalizedFill,
    kind: 'simulated-transparency',
    className,
    label: '透明模拟预览（仅预览）',
    cacheOnly: true,
    downloadable: false,
  };
}
