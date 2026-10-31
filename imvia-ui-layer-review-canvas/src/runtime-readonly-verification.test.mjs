import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeRuntime from '../scripts/node-runtime.mjs';
import * as pythonRuntime from '../scripts/python-runtime.mjs';

for (const [name, module, method, extra] of [
  ['Node', nodeRuntime, 'verifyInstalledNodeRuntime', {}],
  ['Python', pythonRuntime, 'verifyInstalledPythonRuntime', {repositoryRoot:'/fixture/repo'}],
]) {
  test(`${name} verification reports absent installation without writing or downloading`, async () => {
    assert.equal(typeof module[method], 'function');
    const fileSystem = new Proxy({}, {get(target, key) {
      if(key==='readFile') return async () => {throw Object.assign(new Error('missing'),{code:'ENOENT'});};
      return () => {assert.fail(`verification attempted filesystem mutation: ${String(key)}`);};
    }});
    await assert.rejects(module[method]({pluginRoot:'/fixture/plugin',fileSystem,...extra}), /missing|not installed/);
  });
}
