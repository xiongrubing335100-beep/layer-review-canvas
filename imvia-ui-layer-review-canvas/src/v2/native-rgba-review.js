const requiredChecks = ['contentFidelity', 'fullSilhouette', 'thinStructures',
  'holesAndSolidMaterial', 'placement', 'protectedRegions'];
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

// File validity and transparency alone cannot establish visual correctness.
export function nativeRgbaReviewPassed(report) {
  return report?.visualReview?.status === 'passed'
    && sha256(report.rawSha256) && sha256(report.finalPreview?.rgbaSha256)
    && requiredChecks.every(name => report.nativeRgbaChecks?.[name] === true);
}
