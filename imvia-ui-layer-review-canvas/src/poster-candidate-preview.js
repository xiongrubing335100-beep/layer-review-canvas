import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function inside(root, target) {
  return target.startsWith(`${root}${path.sep}`);
}

async function assertNoSymlinkSegments(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('候选预览路径超出允许目录');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error('候选预览不允许符号链接');
  }
}

export async function readSafePosterCandidatePreview({ candidatesRoot, candidatePath } = {}) {
  if (typeof candidatesRoot !== 'string' || typeof candidatePath !== 'string') throw new TypeError('候选预览路径无效');
  const root = path.resolve(candidatesRoot);
  const target = path.resolve(candidatePath);
  if (!inside(root, target) || path.extname(target).toLowerCase() !== '.png') throw new Error('候选预览必须是允许目录中的 PNG');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('候选目录不安全');
  await assertNoSymlinkSegments(root, target);
  const [physicalRoot, physicalTarget, targetInfo] = await Promise.all([realpath(root), realpath(target), lstat(target)]);
  if (!inside(physicalRoot, physicalTarget) || !targetInfo.isFile()) throw new Error('候选预览文件不安全');
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('候选预览文件不安全');
    const bytes = await handle.readFile();
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error('候选预览必须是有效 PNG');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
