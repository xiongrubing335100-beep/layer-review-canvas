import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { jobsForPolling, reconcileTurnStatus } from './job-state.js';

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

async function runIsolatedLauncher(directory) {
  const environment = { ...process.env };
  delete environment.IMVIA_WORKBENCH_SESSION_ID;
  const child = spawn(process.execPath, [path.join(directory, 'scripts', 'start-workbench.mjs')], {
    cwd: directory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  let timer;
  let output = '';
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`isolated launcher did not start: ${output}`)), 5_000);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`isolated launcher exited ${code}: ${output}`)));
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const session = output.match(/IMVIA_TEST_SESSION ([^\r\n]+)/)?.[1];
        if (session) resolve(session);
      });
    });
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    await exited;
  }
}

test('a workbench restart passes the same persisted session id to its page server', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imvia-lifecycle-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await copyFile(
    path.join(rootDirectory, 'scripts', 'start-workbench.mjs'),
    path.join(directory, 'scripts', 'start-workbench.mjs'),
  );
  await symlink(path.join(rootDirectory, 'src'), path.join(directory, 'src'), 'dir');
  const serverEntry = path.join(directory, 'node_modules', 'vite', 'bin', 'vite.js');
  await mkdir(path.dirname(serverEntry), { recursive: true });
  // Replace only the external page server; run the real lifecycle owner and stores.
  // This child binds no port and has no access to the user's active output directory.
  await writeFile(serverEntry, `
process.stdout.write('IMVIA_TEST_SESSION ' + process.env.IMVIA_WORKBENCH_SESSION_ID + '\\n');
setInterval(() => {}, 1000);
`);
  const firstSession = await runIsolatedLauncher(directory);
  assert.match(firstSession, /^[0-9a-f-]{36}$/);
  const sessionPath = path.join(directory, 'output', 'workbench-runtime', 'workbench-session.json');
  assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).workbenchSessionId, firstSession);

  const restartedSession = await runIsolatedLauncher(directory);
  assert.equal(restartedSession, firstSession);
  assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).workbenchSessionId, firstSession);
});

test('generated results keep polling during validation until a completed report is available', () => {
  const pending = reconcileTurnStatus({
    planStatus: 'processing',
    reportStatus: null,
    turnStatus: null,
    resultReady: true,
    imageCount: 1,
  });
  assert.equal(pending.status, 'finalizing');
  const job = { id: 'validation-job', ...pending, snapshotVerified: true };
  assert.deepEqual(jobsForPolling([job]).map(({ id }) => id), ['validation-job']);

  const completed = reconcileTurnStatus({
    planStatus: 'processing',
    reportStatus: 'completed',
    turnStatus: null,
    resultReady: true,
    imageCount: 1,
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(jobsForPolling([{ ...job, ...completed, completedAt: 1_000 }]), []);
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
