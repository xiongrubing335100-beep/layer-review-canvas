import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearStoredProjectImages,
  createImageDocument,
  createProjectState,
  imageIdentity,
  removeImageDocument,
  serializeProject,
  upsertImageDocument,
} from './project-state.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('project state keeps independent image documents', () => {
  const first = createImageDocument({ imageId: 'image-a', sourceName: 'a.png' });
  const second = createImageDocument({ imageId: 'image-b', sourceName: 'b.png' });
  let project = upsertImageDocument(createProjectState({ projectId: 'project-1' }), first);
  project = upsertImageDocument(project, second);

  assert.equal(Object.keys(project.images).length, 2);
  assert.equal(project.images['image-a'].sourceName, 'a.png');
  assert.equal(project.images['image-b'].sourceName, 'b.png');
});

test('removing an image only changes the active image pointer and that image entry', () => {
  let project = createProjectState({ projectId: 'project-1', activeImageId: 'image-a' });
  project = upsertImageDocument(project, { imageId: 'image-a', sourceName: 'a.png' });
  project = upsertImageDocument(project, { imageId: 'image-b', sourceName: 'b.png' });
  project = removeImageDocument(project, 'image-a');

  assert.equal(project.activeImageId, 'image-b');
  assert.deepEqual(Object.keys(project.images), ['image-b']);
});

test('project identity is carried into a submission without relying on the filename', () => {
  assert.deepEqual(imageIdentity({
    projectId: 'project-1',
    imageId: 'image-a',
    sourceFingerprint: 'sha256:a',
    sourceRevision: 2,
  }), {
    projectId: 'project-1',
    imageId: 'image-a',
    sourceFingerprint: 'sha256:a',
    sourceRevision: 2,
  });
});

test('project serialization is JSON-safe', () => {
  const project = upsertImageDocument(createProjectState(), { imageId: 'image-a', sourceName: 'a.png' });
  assert.deepEqual(serializeProject(project), project);
});

test('clearing stored project images preserves project identity but removes image cache', () => {
  const storage = createStorage();
  const project = upsertImageDocument(createProjectState({ projectId: 'project-1' }), {
    imageId: 'image-a',
    sourceDataUrl: 'data:image/png;base64,cached',
    sourceName: 'cached.png',
  });
  storage.setItem('imvia-layer-project', JSON.stringify(project));

  const cleared = clearStoredProjectImages(storage);
  assert.equal(cleared.projectId, 'project-1');
  assert.equal(cleared.activeImageId, '');
  assert.deepEqual(cleared.images, {});
  assert.deepEqual(JSON.parse(storage.getItem('imvia-layer-project')), cleared);
});
