import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const serverUrl = new URL('../layer-review-mcp-server.mjs', import.meta.url).href;

function inspectTools(environment) {
  const program = [
    `const module = await import(${JSON.stringify(serverUrl)});`,
    'const server = module.createLayerReviewBridgeServer({ environment: JSON.parse(process.env.TEST_ENVIRONMENT) });',
    'const tools = Object.keys(server._registeredTools).sort();',
    "if (!tools.includes('submit_layer_review_job')) throw new Error('UI MCP tool missing');",
    "if (process.env.EXPECT_POSTER === '0') { for (const name of ['get_poster_layer_job', 'cancel_poster_layer_job', 'abandon_poster_layer_job', 'confirm_poster_foreground_dispatch']) if (!tools.includes(name)) throw new Error(`disabled legacy poster control missing: ${name}`); for (const name of ['submit_poster_layer_analysis', 'submit_poster_layer_candidate', 'update_poster_layer_plan', 'confirm_poster_layer_plan', 'accept_poster_layer_candidate', 'authorize_poster_layer_retry', 'reauthorize_poster_audit_layer', 'run_poster_recomposition_audit']) if (tools.includes(name)) throw new Error(`disabled poster mutation remained registered: ${name}`); }",
    "if (process.env.EXPECT_POSTER === '1' && !tools.includes('submit_poster_layer_analysis')) throw new Error('enabled poster tool missing');",
    "if (process.env.EXPECT_POSTER === '0' && server._registeredTools.submit_poster_layer_analysis !== undefined) throw new Error('disabled poster tool remained directly callable');",
    "if (process.env.EXPECT_POSTER === '0') { server.setToolRequestHandlers(); const call = server.server._requestHandlers.get('tools/call'); const result = await call({ method: 'tools/call', params: { name: 'submit_poster_layer_analysis', arguments: {} } }, {}); if (!result.isError || !result.content?.[0]?.text?.includes('not found')) throw new Error('disabled poster direct call did not fail closed'); }",
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '--eval', program], {
      cwd: root,
      env: { ...process.env, IMVIA_LAYER_MCP_TEST_MODE: '1', TEST_ENVIRONMENT: JSON.stringify(environment), EXPECT_POSTER: environment.IMVIA_FEATURE_POSTER_LAYERING_MODE === '0' ? '0' : '1' },
    }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve());
  });
}

test('MCP registers poster tools only while poster layering is enabled', async () => {
  await assert.doesNotReject(inspectTools({}));
  await assert.doesNotReject(inspectTools({ IMVIA_FEATURE_POSTER_LAYERING_MODE: '0' }));
});
