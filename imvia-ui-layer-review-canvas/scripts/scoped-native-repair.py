"""Merge independently source-composited RGBA only in diagnosed local regions."""
import numpy as np
from PIL import Image

def scope_cut_edges(before, after, proposal, scope, source):
    """Count new scope seams without a matching source color transition."""
    first, second, merged = (values[..., 3] >= 128 for values in (before, after, proposal))
    count = 0
    height, width = scope.shape
    for left, right, dx, dy in ((np.s_[:, :-1], np.s_[:, 1:], 1, 0),
                                (np.s_[:-1, :], np.s_[1:, :], 0, 1)):
        cut = (scope[left] != scope[right]) & (merged[left] != merged[right])
        cut &= (first[left] == first[right]) & (second[left] == second[right])
        y, x = np.where(cut)
        if not len(x):
            continue
        # Inspect the source across this exact edge, not a nearby edge with
        # a different orientation. Two short stable color plateaus support
        # a genuine corner; a smooth ramp or texture does not establish one.
        sides = []
        for offsets in ((0, -1, -2), (1, 2, 3)):
            samples = np.stack([source[np.clip(y+k*dy, 0, height-1),
                                       np.clip(x+k*dx, 0, width-1)] for k in offsets]).astype(float)
            center = np.median(samples, axis=0)
            spread = np.linalg.norm(samples-center, axis=2).max(axis=0)
            sides.append((center, spread))
        contrast = np.linalg.norm(sides[0][0]-sides[1][0], axis=1)
        spread = np.maximum(sides[0][1], sides[1][1])
        # Profile centers are three pixels apart. A linear ramp therefore
        # produces exactly 3× the within-side spread, not a source edge.
        supported = (contrast > 5) & (contrast > 3*spread + 1e-6)
        count += int(np.count_nonzero(~supported))
    return count


def select_source_supported_groups(before, after, mask, source):
    """Select complete RGBA edits; never synthesize a matte or blend contours."""
    import importlib.util
    from pathlib import Path
    from scipy import ndimage
    spec = importlib.util.spec_from_file_location(
        'repair_source_evidence', Path(__file__).with_name('source-guided-matte.py'))
    evidence = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evidence)
    changed = mask & np.any(before != after, axis=2)
    # Color-only adjustments must not glue independent contour edits together.
    # Keep additions and removals separate; each still copies complete RGBA.
    alpha_delta = after[..., 3].astype(np.int16) - before[..., 3].astype(np.int16)
    labels = np.zeros(mask.shape, np.int32)
    count = 0
    for direction in (alpha_delta > 0, alpha_delta < 0, alpha_delta == 0):
        group_labels, group_count = ndimage.label(changed & direction, structure=np.ones((3, 3)))
        occupied = group_labels > 0
        labels[occupied] = group_labels[occupied] + count
        count += group_count
    foreground, foreground_count = ndimage.label(before[..., 3] >= 128, structure=np.ones((3, 3)))
    result = before.copy()
    accepted = rejected = 0
    decisions = []
    for index, box in enumerate(ndimage.find_objects(labels), 1):
        if box is None:
            continue
        edit = labels == index
        proposal = result.copy()
        proposal[edit] = after[edit]
        # A vanishing object has no boundary left to fail an edge test.
        touched = np.unique(foreground[edit])
        if any(label and not np.any((foreground == label) & (proposal[..., 3] >= 128))
               for label in touched):
            rejected += 1
            continue
        if np.array_equal(result[..., 3][edit], proposal[..., 3][edit]):
            result = proposal
            accepted += 1
            continue
        ys, xs = box
        cut_edges = scope_cut_edges(result, after, proposal, mask, source)
        if cut_edges:
            # A better average edge score cannot justify a new boundary
            # created by clipping a repair to its permission rectangle.
            rejected += 1
            decisions.append({
                'bounds': [xs.start, ys.start, xs.stop-xs.start, ys.stop-ys.start],
                'changedPixels': int(edit.sum()), 'accepted': False,
                'reason': 'scope_cut_boundary', 'cutEdges': cut_edges,
            })
            continue
        crop = (slice(max(0, ys.start-16), min(mask.shape[0], ys.stop+16)),
                slice(max(0, xs.start-16), min(mask.shape[1], xs.stop+16)))
        query = ndimage.binary_dilation(edit[crop], iterations=4)

        def score(values):
            alpha = values[crop][..., 3]
            visible = alpha >= 128
            boundary = visible & ~ndimage.binary_erosion(visible) & query
            if not boundary.any():
                return (0, 0)
            try:
                audit, unsupported = evidence.source_contour_evidence(
                    source[crop], visible, np.zeros(visible.shape, bool),
                    material=True, alpha=alpha, query=query)
                return (int(np.count_nonzero(unsupported)), audit['longestUnsupportedRun'])
            except ValueError:
                # No local contrast is not evidence of a valid boundary.
                return (int(boundary.sum()), int(boundary.sum()))

        original_score = score(result)
        proposed_score = score(proposal)
        improves = (all(new <= old for new, old in zip(proposed_score, original_score))
                    and proposed_score != original_score)
        decisions.append({
            'bounds': [xs.start, ys.start, xs.stop-xs.start, ys.stop-ys.start],
            'changedPixels': int(edit.sum()),
            'originalScore': original_score, 'proposedScore': proposed_score,
            'accepted': improves,
        })
        if improves:
            result = proposal
            accepted += 1
        else:
            rejected += 1
    return result, {'editGroups': count, 'acceptedEditGroups': accepted,
                    'preservedOriginalGroups': rejected, 'groupDecisions': decisions}


def merge_scoped_repair(initial, repaired, defects, permission, *, source=None):
    if initial.size != repaired.size or initial.size != permission.size:
        raise ValueError('REPAIR_DIMENSIONS_MISMATCH')
    width,height=initial.size
    if not defects or len(defects)>16:
        raise ValueError('REPAIR_DEFECTS_REQUIRED')
    mask=np.zeros((height,width),dtype=bool); area=0
    for d in defects:
        x,y,w,h=(d.get(k) for k in ('x','y','width','height'))
        if not all(type(v) is int for v in (x,y,w,h)) or min(x,y)<0 or min(w,h)<1 or x+w>width or y+h>height:
            raise ValueError('REPAIR_INVALID_DEFECT_SCOPE')
        area+=w*h; mask[y:y+h,x:x+w]=True
    if area>width*height*.25:
        raise ValueError('REPAIR_SCOPE_TOO_BROAD')
    # Partially covered boundary pixels remain protected; do not expand paths.
    mask &= np.array(permission)==255
    if not np.any(mask):
        raise ValueError('REPAIR_EMPTY_ALLOWED_SCOPE')
    before=np.array(initial.convert('RGBA')); after=np.array(repaired.convert('RGBA'))
    selection = {}
    if source is None:
        output=before.copy(); output[mask]=after[mask]
    else:
        if source.size != initial.size:
            raise ValueError('REPAIR_DIMENSIONS_MISMATCH')
        output, selection = select_source_supported_groups(
            before, after, mask, np.asarray(source.convert('RGB')))
    return Image.fromarray(output), {
        'scopePixels':int(mask.sum()),'changedRgbaPixels':int(np.any(output!=before,axis=2).sum()),
        'changedAlphaPixels':int((output[:,:,3]!=before[:,:,3]).sum()),
        'outsideScopeRgbaIdentical':bool(np.array_equal(output[~mask],before[~mask])),
        **selection}
