import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_NODE_RANGE = '^20.19.0 || >=22.12.0';

function parseNodeVersion(version) {
  const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  if (major === 22) return minor >= 12;
  return major > 22;
}

export function assertSupportedNodeVersion(version = process.version) {
  if (isSupportedNodeVersion(version)) return;
  throw new Error(
    `Imvia Layer 检测到 Node.js ${version}，但要求 ${SUPPORTED_NODE_RANGE}。`
    + '请安装 Node.js 22 LTS（推荐）或其他符合范围的版本后重试。',
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
