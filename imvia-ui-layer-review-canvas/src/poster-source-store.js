import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPosterPngDimensions } from './poster-png.js';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export async function storePosterSource({ outputRoot, bytes, sourcePath, expectedSize } = {}) {
  if (sourcePath !== undefined) throw new Error('source path must be server-owned');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_SOURCE_BYTES) {
    throw new Error('poster source payload is invalid');
  }
  const directory = path.join(outputRoot, 'poster-sources');
  await mkdir(directory, { recursive: true });
  const id = crypto.randomUUID();
  const filename = `source-${id}.png`;
  const temporary = path.join(directory, `.${filename}.tmp`);
  const target = path.join(directory, filename);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    const dimensions = await readPosterPngDimensions(temporary, 'poster source');
    if (expectedSize && (dimensions.width !== expectedSize.width || dimensions.height !== expectedSize.height)) {
      throw new Error('poster source dimensions do not match the upload headers');
    }
    await writeFile(target, bytes, { flag: 'wx' });
    return { sourcePath: path.posix.join('output', 'poster-sources', filename), ...dimensions };
  } finally {
    await rm(temporary, { force: true });
  }
}
