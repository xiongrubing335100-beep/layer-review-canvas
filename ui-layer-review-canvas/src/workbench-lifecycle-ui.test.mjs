import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the page keeps a renewable lease and treats close as a hint', async () => {
  const source = await readFile(path.join(rootDirectory, 'src', 'main.jsx'), 'utf8');
  assert.match(source, /api\/layer-review\/page-lease/);
  assert.match(source, /PAGE_HEARTBEAT_INTERVAL_MS/);
  assert.match(source, /pagehide/);
  assert.match(source, /sendBeacon/);
});

test('discarded jobs are removed instead of becoming failed ghost cards', async () => {
  const [source, host] = await Promise.all([
    readFile(path.join(rootDirectory, 'src', 'main.jsx'), 'utf8'),
    readFile(path.join(rootDirectory, 'src', 'mcp-workbench-host.js'), 'utf8'),
  ]);
  assert.match(host, /response\.status === 410/);
  assert.match(host, /status: 'discarded'/);
  assert.match(source, /current\.filter\(\(job\) => !discardedIds\.has\(job\.id\)\)/);
});

test('the server queues a second bridge job before creating its directory', async () => {
  const source = await readFile(path.join(rootDirectory, 'vite.config.js'), 'utf8');
  const gateIndex = source.indexOf('findBlockingJob(rootOutputDirectory)');
  const deliveryIndex = source.indexOf('resolveSubmissionDeliveryMode({', gateIndex);
  const createIndex = source.indexOf('await mkdir(jobDirectory, { recursive: true })');
  assert.ok(gateIndex >= 0);
  assert.ok(deliveryIndex > gateIndex);
  assert.ok(createIndex > gateIndex);
  assert.match(source, /\.submission\.lock/);
  assert.match(source, /withDirectoryLock/);
  assert.match(source, /const queued = Boolean\(blockingJob\)/);
  assert.match(source, /conversationBridgeOnline: bridgePresence\.online,[\s\S]*queued,/);
  assert.match(source, /status: queued \? 'queued' : 'awaiting_codex_message'/);
});

test('a workbench restart abandons started jobs without execution reports', async () => {
  const source = await readFile(path.join(rootDirectory, 'scripts', 'start-workbench.mjs'), 'utf8');
  assert.match(source, /shouldMarkJobAbandoned\(\{/);
  assert.match(source, /status: 'abandoned_running'/);
  assert.match(source, /reportCompletedAt: record\.reportCompletedAt/);
});

test('a workbench restart reuses its persisted conversation session id', async () => {
  const source = await readFile(path.join(rootDirectory, 'scripts', 'start-workbench.mjs'), 'utf8');
  assert.match(source, /workbench-session\.json/);
  assert.match(source, /resolveWorkbenchSessionId/);
  assert.match(source, /IMVIA_WORKBENCH_SESSION_ID/);
  assert.match(source, /await writeFile\(sessionPath/);
});

test('the workbench presents transparent repair stages and polls at one second', async () => {
  const source = await readFile(path.join(rootDirectory, 'src', 'main.jsx'), 'utf8');
  assert.match(source, /repair_rgb: \{ label: '正在补全隐藏结构'/);
  assert.match(source, /alpha_matte: \{ label: '正在生成透明蒙版'/);
  assert.match(source, /finalizing: \{ label: '正在验收'/);
  assert.match(source, /正在校验补全结果与透明蒙版/);
  assert.match(source, /const interval = window\.setInterval\(refresh, 1000\);/);
});

test('transparent repair stages remain active lifecycle states', async () => {
  const source = await readFile(path.join(rootDirectory, 'src', 'workbench-lifecycle.js'), 'utf8');
  assert.match(source, /'repair_rgb'/);
  assert.match(source, /'alpha_matte'/);
});
