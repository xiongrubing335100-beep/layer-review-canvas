const PROJECT_VERSION = 1;

function cleanSize(size) {
  return {
    width: Number.isFinite(size?.width) ? size.width : 0,
    height: Number.isFinite(size?.height) ? size.height : 0,
  };
}

export function createImageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createProjectId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createImageDocument({
  imageId = createImageId(),
  sourceImage = '',
  sourceDataUrl = '',
  sourceName = '',
  sourceSize = { width: 0, height: 0 },
  sourceFingerprint = '',
  sourceRevision = 1,
  nodes = [],
  selectedId = '',
  sourceNodePosition = { x: 110, y: 240 },
  canvasLayoutVersion = 0,
  resultNodePositions = {},
  manualResultNodes = [],
  manualEdges = [],
  marks = [],
} = {}) {
  return {
    imageId,
    sourceImage,
    sourceDataUrl,
    sourceName,
    sourceSize: cleanSize(sourceSize),
    sourceFingerprint,
    sourceRevision,
    nodes,
    selectedId,
    sourceNodePosition,
    canvasLayoutVersion,
    resultNodePositions,
    manualResultNodes,
    manualEdges,
    marks,
  };
}

export function createProjectState({ projectId = createProjectId(), activeImageId = '' } = {}) {
  return {
    version: PROJECT_VERSION,
    projectId,
    activeImageId,
    images: {},
  };
}

export function upsertImageDocument(project, image) {
  const next = project || createProjectState();
  const document = createImageDocument(image);
  return {
    ...next,
    activeImageId: next.activeImageId || document.imageId,
    images: { ...next.images, [document.imageId]: document },
  };
}

export function removeImageDocument(project, imageId) {
  if (!project?.images?.[imageId]) return project;
  const images = { ...project.images };
  delete images[imageId];
  const remainingIds = Object.keys(images);
  return {
    ...project,
    activeImageId: project.activeImageId === imageId ? (remainingIds[0] || '') : project.activeImageId,
    images,
  };
}

export function imageIdentity(image) {
  return {
    projectId: image?.projectId || null,
    imageId: image?.imageId || null,
    sourceFingerprint: image?.sourceFingerprint || null,
    sourceRevision: Number.isInteger(image?.sourceRevision) ? image.sourceRevision : null,
  };
}

export function serializeProject(project) {
  return JSON.parse(JSON.stringify(project || createProjectState()));
}

export function readStoredProjectState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem('imvia-layer-project');
    if (!raw) return createProjectState();
    const parsed = JSON.parse(raw);
    if (!parsed?.projectId || !parsed?.images || typeof parsed.images !== 'object') {
      return createProjectState();
    }
    return {
      ...createProjectState({ projectId: parsed.projectId, activeImageId: parsed.activeImageId || '' }),
      ...parsed,
    };
  } catch {
    return createProjectState();
  }
}

export function writeStoredProjectState(project, storage = globalThis.localStorage) {
  try {
    storage?.setItem('imvia-layer-project', JSON.stringify(serializeProject(project)));
  } catch {
    // Storage quota and private-mode failures should not block editing.
  }
}

export function clearStoredProjectImages(storage = globalThis.localStorage) {
  const project = readStoredProjectState(storage);
  if (!Object.keys(project.images || {}).length && !project.activeImageId) return project;
  const cleared = {
    ...project,
    activeImageId: '',
    images: {},
  };
  writeStoredProjectState(cleared, storage);
  return cleared;
}
