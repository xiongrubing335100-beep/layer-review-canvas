import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: false,
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`)));
  });
}

function checkPython(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, [...args, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.once('error', () => resolve(null));
    child.once('exit', (code) => {
      const match = output.trim().match(/^(\d+)\.(\d+)$/);
      if (code !== 0 || !match) return resolve(null);
      const major = Number(match[1]);
      const minor = Number(match[2]);
      resolve(major > 3 || (major === 3 && minor >= 10) ? `${major}.${minor}` : null);
    });
  });
}

async function resolvePython() {
  const configured = process.env.PYTHON?.trim();
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

  for (const candidate of candidates) {
    const version = await checkPython(candidate.command, candidate.args);
    if (version) return { ...candidate, version };
  }

  const overrideHint = configured ? `PYTHON=${configured} 不可用或版本低于 3.10` : '未找到 Python 3.10+';
  throw new Error(`${overrideHint}。请安装 Python 3.10+，或设置 PYTHON 指向可用的 Python 可执行文件后重试。`);
}

try {
  const python = await resolvePython();
  process.stdout.write(`使用 Python ${python.version}：${[python.command, ...python.args].join(' ')}\n`);
  process.stdout.write('1/3 安装 RMBG 依赖…\n');
  await run(python.command, [...python.args, '-m', 'pip', 'install', '-r', 'requirements-rmbg.txt']);
  process.stdout.write('2/3 下载并校验 BRIA RMBG 2.0（bria-rmbg）模型…\n');
  await run(python.command, [...python.args, 'scripts/warm-rmbg.py']);
  process.stdout.write('3/3 注册 Imvia Layer 插件…\n');
  await run(process.execPath, ['scripts/install-codex-plugin.mjs'], {
    env: {
      ...process.env,
      IMVIA_LAYER_PYTHON_COMMAND: python.command,
      IMVIA_LAYER_PYTHON_ARGS: JSON.stringify(python.args),
    },
  });
} catch (error) {
  process.stderr.write(`Imvia Layer 初始化失败：${error.message}\n`);
  process.exitCode = 1;
}
