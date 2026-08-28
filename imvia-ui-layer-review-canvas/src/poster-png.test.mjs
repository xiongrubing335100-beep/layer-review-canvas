import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { validateKeyedPosterCandidate } from './poster-png.js';

function crc32(...buffers) { let crc = 0xffffffff; for (const buffer of buffers) for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const bytes = Buffer.from(type); const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length, 0); bytes.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(bytes, data), data.length + 8); return result; }
async function png(filePath, { color = [0, 255, 0], rgba = false, incidentalKey = false } = {}) {
  const channels = rgba ? 4 : 3; const raw = Buffer.alloc((2 * channels + 1) * 2);
  for (let row = 0; row < 2; row += 1) for (let column = 0; column < 2; column += 1) { const offset = row * (2 * channels + 1) + 1 + column * channels; raw[offset] = color[0]; raw[offset + 1] = color[1]; raw[offset + 2] = color[2]; if (rgba) raw[offset + 3] = 255; }
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = rgba ? 6 : 2;
  if (incidentalKey) { raw[1] = 0; raw[2] = 255; raw[3] = 0; }
  await writeFile(filePath, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('keyed candidates require a complete RGB PNG with the declared full-canvas key', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-png-')); context.after(() => rm(root, { recursive: true, force: true }));
  const valid = path.join(root, 'valid.png'); const black = path.join(root, 'black.png'); const alpha = path.join(root, 'alpha.png'); const corrupt = path.join(root, 'corrupt.png'); const incidental = path.join(root, 'incidental.png');
  await png(valid); await png(black, { color: [0, 0, 0] }); await png(alpha, { rgba: true }); await png(incidental, { color: [255, 0, 0], incidentalKey: true }); await writeFile(corrupt, Buffer.from('not a png'));
  assert.deepEqual(await validateKeyedPosterCandidate(valid, { width: 2, height: 2, fillColor: '#00FF00' }), { width: 2, height: 2, fillColor: '#00FF00', keyFieldPixels: 4 });
  assert.equal((await validateKeyedPosterCandidate(black, { width: 2, height: 2, fillColor: '#000000' })).keyFieldPixels, 4);
  await assert.rejects(validateKeyedPosterCandidate(black, { width: 2, height: 2, fillColor: '#00FF00' }), /key field/);
  await assert.rejects(validateKeyedPosterCandidate(alpha, { width: 2, height: 2, fillColor: '#00FF00' }), /alpha channel/);
  await assert.rejects(validateKeyedPosterCandidate(incidental, { width: 2, height: 2, fillColor: '#00FF00' }), /key field/);
  await assert.rejects(validateKeyedPosterCandidate(corrupt, { width: 2, height: 2, fillColor: '#00FF00' }), /signature/);
});
