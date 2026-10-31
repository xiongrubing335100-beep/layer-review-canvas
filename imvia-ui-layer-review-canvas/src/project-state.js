import { normalizeDocumentMode } from './poster-mode.js';

const PROJECT_VERSION = 1;
const WORKBENCH_OPEN_TOKEN_KEY = 'imvia-layer-workbench-open-token';

function cleanSize(size) {
  return {
    width: Number.isFinite(size?.width) ? size.width : 0,
    height: Number.isFinite(size?.height) ? size.height : 0,
  };
}

function normalizeStoredImageDocument(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return image;
  return {
    ...image,
    documentMode: normalizeDocumentMode(image.documentMode),
    posterJobId: typeof image.posterJobId === 'string' ? image.posterJobId : '',
    posterDispatchId: typeof image.posterDispatchId === 'string' ? image.posterDispatchId : '',
    posterPlanVersion: Number.isInteger(image.posterPlanVersion) ? image.posterPlanVersion : 0,
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
  documentMode = 'ui',
  posterJobId = '',
  posterDispatchId = '',
  posterPlanVersion = 0,
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
    documentMode: normalizeDocumentMode(documentMode),
    posterJobId: typeof posterJobId === 'string' ? posterJobId : '',
    posterDispatchId: typeof posterDispatchId === 'string' ? posterDispatchId : '',
    posterPlanVersion: Number.isInteger(posterPlanVersion) ? posterPlanVersion : 0,
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

function lightweightStoredImageDocument(image) {
  const document = normalizeStoredImageDocument(image);
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const sourceImage = typeof document.sourceImage === 'string'
    && !/^(?:data|blob):/i.test(document.sourceImage)
    ? document.sourceImage
    : '';
  return {
    ...document,
    sourceImage,
    sourceDataUrl: '',
  };
}

function projectForStorage(project) {
  const serialized = serializeProject(project);
  return {
    ...serialized,
    images: Object.fromEntries(Object.entries(serialized.images || {}).map(([imageId, image]) => [
      imageId,
      lightweightStoredImageDocument(image),
    ])),
  };
}

export function readStoredProjectState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem('imvia-layer-project');
    if (!raw) return createProjectState();
    const parsed = JSON.parse(raw);
    if (!parsed?.projectId || !parsed?.images || typeof parsed.images !== 'object') {
      return createProjectState();
    }
    const images = Object.fromEntries(
      Object.entries(parsed.images).map(([imageId, image]) => [
        imageId,
        normalizeStoredImageDocument(image),
      ]),
    );
    return {
      ...createProjectState({ projectId: parsed.projectId, activeImageId: parsed.activeImageId || '' }),
      ...parsed,
      images,
    };
  } catch {
    return createProjectState();
  }
}

export function writeStoredProjectState(project, storage = globalThis.localStorage) {
  try {
    storage?.setItem('imvia-layer-project', JSON.stringify(projectForStorage(project)));
  } catch {
    // Storage quota and private-mode failures should not block editing.
  }
}

export function clearStoredProjectImages(
  storage = globalThis.localStorage,
  { preservePosterBindings = true } = {},
) {
  const project = readStoredProjectState(storage);
  const recoverablePosterImages = preservePosterBindings
    ? Object.fromEntries(Object.entries(project.images || {})
      .filter(([, image]) => normalizeDocumentMode(image?.documentMode) === 'poster'
        && typeof image?.posterJobId === 'string' && image.posterJobId.length > 0)
      .map(([imageId, image]) => [imageId, lightweightStoredImageDocument(image)]))
    : {};
  const recoverableIds = Object.keys(recoverablePosterImages);
  if (recoverableIds.length > 0) {
    const recovered = {
      ...project,
      activeImageId: recoverablePosterImages[project.activeImageId]
        ? project.activeImageId
        : recoverableIds[0],
      images: recoverablePosterImages,
    };
    writeStoredProjectState(recovered, storage);
    return recovered;
  }
  if (!Object.keys(project.images || {}).length && !project.activeImageId) return project;
  const cleared = {
    ...project,
    activeImageId: '',
    images: {},
  };
  writeStoredProjectState(cleared, storage);
  return cleared;
}

export function seedStoredProjectForWorkbenchOpen({
  storage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  search = globalThis.location?.search || '',
} = {}) {
  const openToken = new URLSearchParams(search).get('open') || '';
  if (!openToken) return clearStoredProjectImages(storage);

  let previousOpenToken = '';
  try {
    previousOpenToken = sessionStorage?.getItem(WORKBENCH_OPEN_TOKEN_KEY) || '';
    sessionStorage?.setItem(WORKBENCH_OPEN_TOKEN_KEY, openToken);
  } catch {
    // A fresh launch should still fail safe to the empty workbench state.
  }
  return clearStoredProjectImages(storage, {
    preservePosterBindings: previousOpenToken === openToken,
  });
}
