import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(repositoryRoot, 'dist', 'assets');
const banner = 'Imvia Layer © 2026 青木';
const bundles = (await readdir(assetsRoot)).filter((name) => name.endsWith('.js'));
if (bundles.length === 0) throw new Error('production build emitted no JavaScript bundles');
for (const bundle of bundles) {
  const contents = await readFile(path.join(assetsRoot, bundle), 'utf8');
  const count = contents.split(banner).length - 1;
  if (count !== 1) throw new Error(`${bundle} contains ${count} Imvia legal banners; expected exactly 1`);
}
process.stdout.write(`production bundles verified: ${bundles.length}, one legal banner each\n`);
