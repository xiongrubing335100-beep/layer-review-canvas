/** Geometry/file checks cannot overrule an explicit semantic rejection. */
export function semanticReviewAllowsDelivery(report) {
  // Absence is retained for historical reports, not interpreted as new evidence.
  // Historical proposals explicitly deferred geometry to the source finalizer;
  // that is not a semantic rejection. Their final contour must still pass the
  // shared geometry gate. New manifests require an explicit passed review.
  return report?.visualReview === undefined || report.visualReview?.status === 'passed'
    || report.visualReview?.status === 'proposal_requires_source_alignment';
}
