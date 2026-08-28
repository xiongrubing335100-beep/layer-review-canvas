export function startPosterBusy(imageIds, imageId) {
  return new Set([...imageIds, imageId]);
}

export function finishPosterBusy(imageIds, imageId) {
  const nextImageIds = new Set(imageIds);
  nextImageIds.delete(imageId);
  return nextImageIds;
}

export function isPosterBusy(imageIds, imageId) {
  return imageIds.has(imageId);
}
