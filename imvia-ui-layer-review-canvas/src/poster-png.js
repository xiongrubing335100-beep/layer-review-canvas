import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function fail(label, detail) { throw new Error(`${label} PNG ${detail}`); }
function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : (aboveDistance <= upperLeftDistance ? above : upperLeft);
}
function unfilter(data, width, height, channels, label) {
  const rowBytes = width * channels;
  const output = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const filter = data[row * (rowBytes + 1)];
    if (filter > 4) fail(label, 'has an invalid scanline filter');
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = data[row * (rowBytes + 1) + 1 + column];
      const left = column >= channels ? output[row * rowBytes + column - channels] : 0;
      const above = row > 0 ? output[(row - 1) * rowBytes + column] : 0;
      const upperLeft = row > 0 && column >= channels ? output[(row - 1) * rowBytes + column - channels] : 0;
      const value = filter === 0 ? encoded : filter === 1 ? encoded + left : filter === 2 ? encoded + above : filter === 3 ? encoded + Math.floor((left + above) / 2) : encoded + paeth(left, above, upperLeft);
      output[row * rowBytes + column] = value & 0xff;
    }
  }
  return output;
}

export function readPosterPngBytes(png, label = 'PNG') {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) fail(label, 'has an invalid signature');
  let offset = 8; let header; let sawIdat = false; let idatEnded = false; let sawIend = false; let index = 0;
  const compressed = [];
  while (offset < png.length) {
    if (sawIend || png.length - offset < 12) fail(label, 'is truncated or has trailing data');
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) fail(label, 'has a truncated chunk');
    const typeBytes = png.subarray(offset + 4, offset + 8); const type = typeBytes.toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || png.readUInt32BE(offset + 8 + length) !== crc32(typeBytes, data)) fail(label, 'has an invalid chunk CRC');
    if (index === 0 && type !== 'IHDR') fail(label, 'does not start with IHDR');
    if (type === 'IHDR') {
      if (header || index !== 0 || length !== 13) fail(label, 'has an invalid IHDR');
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (!header.width || !header.height || header.bitDepth !== 8 || ![2, 6].includes(header.colorType) || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) fail(label, 'must be 8-bit RGB/RGBA non-interlaced');
    } else if (type === 'IDAT') {
      if (!header || idatEnded) fail(label, 'has invalid IDAT ordering');
      sawIdat = true; compressed.push(data);
    } else if (type === 'IEND') {
      if (!header || !sawIdat || length !== 0) fail(label, 'has an invalid IEND');
      sawIend = true;
    } else if (sawIdat) idatEnded = true;
    offset += length + 12; index += 1;
  }
  if (!header || !sawIdat || !sawIend) fail(label, 'is missing required chunks');
  const channels = header.colorType === 6 ? 4 : 3;
  const decodedLength = (header.width * channels + 1) * header.height;
  if (!Number.isSafeInteger(decodedLength) || decodedLength > MAX_DECODED_BYTES) fail(label, 'is too large to decode');
  let raw;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: decodedLength }); } catch { fail(label, 'has invalid compressed pixels'); }
  if (raw.length !== decodedLength) fail(label, 'has an invalid decoded length');
  return { ...header, channels, pixels: unfilter(raw, header.width, header.height, channels, label) };
}

export async function readPosterPng(filePath, label = 'PNG') {
  return readPosterPngBytes(await readFile(filePath), label);
}

export async function readPosterPngDimensions(filePath, label = 'PNG') {
  const { width, height } = await readPosterPng(filePath, label);
  return { width, height };
}
export async function assertPosterSourceDimensions(sourcePath, source) {
  const dimensions = await readPosterPngDimensions(sourcePath, 'stored source');
  if (dimensions.width !== source?.width || dimensions.height !== source?.height) throw new Error('stored source dimensions do not match the poster plan');
  return dimensions;
}
export function validateKeyedPosterCandidateBytes(bytes, { width, height, fillColor } = {}) {
  const png = readPosterPngBytes(bytes, 'candidate input');
  if (png.width !== width || png.height !== height) throw new Error('candidate input dimensions do not match the full source canvas');
  if (png.colorType !== 2) throw new Error('candidate input must not contain an alpha channel');
  const expected = fillColor === '#000000' ? [0, 0, 0] : fillColor === '#00FF00' ? [0, 255, 0] : null;
  if (!expected) throw new Error('candidate input has an unsupported key color');
  const pixelCount = png.width * png.height;
  const minimumFieldPixels = Math.max(2, Math.ceil(pixelCount * 0.02));
  const visited = new Uint8Array(pixelCount);
  const keyed = (pixel) => {
    const offset = pixel * 3;
    return png.pixels[offset] === expected[0] && png.pixels[offset + 1] === expected[1] && png.pixels[offset + 2] === expected[2];
  };
  const queue = [];
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
    if (x !== 0 && y !== 0 && x !== png.width - 1 && y !== png.height - 1) continue;
    const start = y * png.width + x;
    if (!visited[start] && keyed(start)) { visited[start] = 1; queue.push(start); }
  }
  let fieldPixels = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pixel = queue[cursor]; fieldPixels += 1;
    const x = pixel % png.width; const y = Math.floor(pixel / png.width);
    for (const adjacent of [x > 0 ? pixel - 1 : -1, x < png.width - 1 ? pixel + 1 : -1,
      y > 0 ? pixel - png.width : -1, y < png.height - 1 ? pixel + png.width : -1]) {
      if (adjacent >= 0 && !visited[adjacent] && keyed(adjacent)) { visited[adjacent] = 1; queue.push(adjacent); }
    }
  }
  if (fieldPixels < minimumFieldPixels) throw new Error(`candidate input is missing required ${fillColor} key field`);
  return { width: png.width, height: png.height, fillColor, keyFieldPixels: fieldPixels };
}

export async function validateKeyedPosterCandidate(filePath, options = {}) {
  return validateKeyedPosterCandidateBytes(await readFile(filePath), options);
}
