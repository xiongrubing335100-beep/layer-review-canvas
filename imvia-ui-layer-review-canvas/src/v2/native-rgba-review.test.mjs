import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRgbaReviewPassed } from './native-rgba-review.js';

test('native RGBA requires complete visual evidence bound to both raw and final pixels', () => {
  const report = { visualReview: { status: 'passed' }, rawSha256: 'a'.repeat(64),
    finalPreview: { rgbaSha256: 'b'.repeat(64) }, nativeRgbaChecks: {
      contentFidelity: true, fullSilhouette: true, thinStructures: true,
      holesAndSolidMaterial: true, placement: true, protectedRegions: true } };
  assert.equal(nativeRgbaReviewPassed(report), true);
  for (const name of Object.keys(report.nativeRgbaChecks)) {
    assert.equal(nativeRgbaReviewPassed({ ...report, nativeRgbaChecks: { ...report.nativeRgbaChecks, [name]: false } }), false);
  }
  assert.equal(nativeRgbaReviewPassed({ ...report, finalPreview: undefined }), false);
  assert.equal(nativeRgbaReviewPassed({ ...report, rawSha256: '' }), false);
  assert.equal(nativeRgbaReviewPassed({ checks: { fileValid: true } }), false);
});
