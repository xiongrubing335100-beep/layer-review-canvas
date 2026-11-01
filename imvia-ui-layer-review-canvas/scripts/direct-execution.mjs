// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function isDirectExecution(moduleUrl, {
  argvPath = process.argv[1], platform = process.platform, realpathImpl = realpath,
} = {}) {
  if (!argvPath) return false;
  try {
    const [invoked, modulePath] = await Promise.all([
      realpathImpl(path.resolve(argvPath)), realpathImpl(fileURLToPath(moduleUrl)),
    ]);
    return platform === 'win32' ? invoked.toLowerCase() === modulePath.toLowerCase() : invoked === modulePath;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
