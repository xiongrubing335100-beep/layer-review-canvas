import assert from 'node:assert/strict';
import test from 'node:test';

const preflightUrl = new URL('../scripts/node-version-preflight.mjs', import.meta.url);

async function loadPreflight() {
  return import(`${preflightUrl.href}?test=${Date.now()}-${Math.random()}`).catch(() => null);
}

test('Node version preflight enforces the Vite-supported release boundary', async () => {
  const preflight = await loadPreflight();
  assert.ok(preflight, 'dependency-free Node version preflight module must exist');
  assert.equal(typeof preflight.isSupportedNodeVersion, 'function');
  for (const version of ['v20.19.0', '20.19.0', 'v22.12.0', 'v24.0.0']) {
    assert.equal(preflight.isSupportedNodeVersion(version), true, `${version} should be accepted`);
  }
  for (const version of ['v20.18.0', 'v21.9.0', 'v22.11.0', 'invalid']) {
    assert.equal(preflight.isSupportedNodeVersion(version), false, `${version} should be rejected`);
  }
});

test('Node version preflight reports the exact supported range', async () => {
  const preflight = await loadPreflight();
  assert.ok(preflight, 'dependency-free Node version preflight module must exist');
  assert.throws(
    () => preflight.assertSupportedNodeVersion('v22.11.0'),
    /Node\.js v22\.11\.0.*\^20\.19\.0 \|\| >=22\.12\.0.*Node\.js 22 LTS/s,
  );
});
