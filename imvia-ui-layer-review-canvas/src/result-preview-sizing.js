export function resultPreviewMaxWidth(region, maxHeight) {
  const width = Math.max(1, Number(region?.width) || 1);
  const height = Math.max(1, Number(region?.height) || 1);
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) return width;
  const heightLimitedWidth = Math.max(1, Math.round((width / height) * maxHeight));
  return Math.min(width, heightLimitedWidth);
}
