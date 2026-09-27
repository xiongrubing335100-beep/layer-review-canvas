#!/usr/bin/env node
import { finalizeV2Candidate, finalizeV2Failure } from '../src/v2/candidate-store.js';

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) throw new Error('INVALID_ARGUMENTS');
    values[key.slice(2)] = argv[++index];
  }
  if (!values.manifest) throw new Error('MANIFEST_REQUIRED');
  return values;
}

try {
  const args = parse(process.argv.slice(2));
  let result;
  if (args['failure-code'] || !args.raw || !args.report) {
    result = await finalizeV2Failure({ manifestPath: args.manifest,
      error: { code: args['failure-code'] || 'GENERATION_FAILED', message: args['failure-message'] || 'No usable PNG and review report were provided.' },
      reportPath: args.report || null, rawPath: args.raw || null });
  } else {
    try {
      result = await finalizeV2Candidate({ manifestPath: args.manifest, rawPath: args.raw, mattePath: args.matte || null, reportPath: args.report });
    } catch (error) {
      result = await finalizeV2Failure({ manifestPath: args.manifest, error,
        reportPath: args.report || null, rawPath: args.raw || null });
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.code || 'V2_FINALIZATION_FAILED', message: error.message })}\n`);
  process.exitCode = 1;
}
