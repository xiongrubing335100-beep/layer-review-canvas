"""Estimate a shared mask-to-source alignment before local edge refinement.

This estimates geometry only. It neither changes source pixels nor certifies
delivery. Search uses exterior contours, oriented source edges and disjoint
arc sections for fitting/validation; material-hole decisions remain separate.
"""
import cv2
import numpy as np
from scipy import ndimage as nd
from scipy.optimize import least_squares
from PIL import Image


def _contour_samples(alpha):
    contours, _ = cv2.findContours((alpha >= 128).astype(np.uint8), cv2.RETR_EXTERNAL,
                                  cv2.CHAIN_APPROX_NONE)
    points, normals, held_out = [], [], []
    total = sum(len(c) for c in contours)
    stride = max(1, int(np.ceil(total / 2400)))
    for c in contours:
        p = c[:, 0].astype(float)
        if len(p) < 12:
            continue
        tangent = np.roll(p, -3, axis=0) - np.roll(p, 3, axis=0)
        normal = np.column_stack((-tangent[:, 1], tangent[:, 0]))
        normal /= np.maximum(np.linalg.norm(normal, axis=1)[:, None], 1)
        index = np.arange(0, len(p), stride)
        points.append(p[index]); normals.append(normal[index])
        # Whole arc sections, not neighboring samples of the fitting pixels.
        held_out.append((index // max(8, len(p)//16)) % 2 == 1)
    if not points:
        return None
    return np.concatenate(points), np.concatenate(normals), np.concatenate(held_out)


def _edge_distances(rgb):
    color = cv2.GaussianBlur(rgb.astype(np.float32), (0, 0), .65)
    gx = cv2.Sobel(color, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(color, cv2.CV_32F, 0, 1, ksize=3)
    xx, yy, xy = (gx*gx).sum(2), (gy*gy).sum(2), (gx*gy).sum(2)
    angle = .5*np.arctan2(2*xy, xx-yy)
    edges = np.zeros(rgb.shape[:2], bool)
    for channel in range(3):
        edges |= cv2.Canny(np.ascontiguousarray(rgb[..., channel]), 20, 60) > 0
    return np.asarray([np.minimum(nd.distance_transform_edt(
        ~(edges & (np.abs(np.cos(angle-direction)) >= .8))), 12)
        for direction in np.arange(8)*np.pi/8], dtype=np.float32)


def register_matte(source, matte, scope=None, object_points=(), allow_local=False):
    """Return (aligned PIL mask, audit, forward 2x3 matrix or None).

    Limits are in frozen crop pixels. Only a unique, spatially consistent
    improvement may move the whole assembly; otherwise keep the original.
    """
    original = np.asarray(matte.convert('L'))
    rgb = np.asarray(source.convert('RGB'))
    audit = {'applied': False, 'method': 'source_global_translation',
             'coordinateSpace': 'selected_region_pixels'}
    if rgb.shape[:2] != original.shape:
        raise ValueError('MATTE_DIMENSIONS_MISMATCH')
    samples = _contour_samples(original)
    if samples is None:
        return matte, {**audit, 'reason': 'insufficient_contour'}, None
    points, normals, held_out = samples
    if len(points) < 32 or not held_out.any() or held_out.all():
        return matte, {**audit, 'reason': 'insufficient_contour'}, None
    h, w = original.shape
    limit = max(16, min(96, round(min(h, w)*.15)))
    buckets = np.rint((np.arctan2(normals[:, 1], normals[:, 0]) % np.pi)*8/np.pi).astype(int) % 8
    allowed = np.ones((h, w), bool) if scope is None else np.asarray(scope) > 0
    # Search at bounded resolution; final selection is measured at source size.
    ratio = min(1., 512/max(h, w))
    cw, ch = max(1, round(w*ratio)), max(1, round(h*ratio))
    scale = np.array([cw/w, ch/h])
    coarse = _edge_distances(cv2.resize(rgb, (cw, ch), interpolation=cv2.INTER_AREA))
    cp = (points+.5)*scale-.5

    def distances(field, p):
        result = np.full(len(p), 12., dtype=float)
        ix, iy = np.rint(p).astype(int).T
        valid = (ix >= 0) & (iy >= 0) & (ix < field.shape[2]) & (iy < field.shape[1])
        result[valid] = field[buckets[valid], iy[valid], ix[valid]]
        return result

    scored = []
    span = int(np.ceil(limit*ratio))
    for dy in range(-span, span+1, 2):
        for dx in range(-span, span+1, 2):
            d = distances(coarse, cp+[dx, dy])
            scored.append((float(np.minimum(d[~held_out], 8).mean()), dx, dy))
    scored.sort()
    starts = [(0., 0.)]
    for _, dx, dy in scored:
        if all(np.hypot(dx-x*scale[0], dy-y*scale[1]) >= 4 for x,y in starts[1:]):
            starts.append((dx/scale[0], dy/scale[1]))
        if len(starts) == 7:
            break
    field = coarse if (cw, ch) == (w, h) else _edge_distances(rgb)
    candidates = {}
    for sx, sy in starts:
        reach = int(np.ceil(2/ratio))
        for dy in range(round(sy)-reach, round(sy)+reach+1):
            for dx in range(round(sx)-reach, round(sx)+reach+1):
                if abs(dx) > limit or abs(dy) > limit or (dx,dy) in candidates:
                    continue
                d = np.minimum(distances(field, points+[dx,dy]), 8)
                candidates[dx,dy] = (float(d[~held_out].mean()), d)
    ranked = sorted(candidates, key=lambda k: candidates[k][0])
    best = ranked[0]
    before, after = candidates[0,0][1], candidates[best][1]
    audit.update(offsetPixels=list(best), fitBefore=round(float(before[~held_out].mean()), 4),
                 fitAfter=round(float(after[~held_out].mean()), 4),
                 validationBefore=round(float(before[held_out].mean()), 4),
                 validationAfter=round(float(after[held_out].mean()), 4))
    # Small displacements need independent source verification by the caller.
    # A highlight a few pixels inside a metal rim is not a whole-object offset;
    # allow_local only exposes a proposal, never a delivery certificate.
    local_radius = max(6, min(12, round(min(h, w)*.02)))
    is_local = max(abs(best[0]), abs(best[1])) <= local_radius
    if is_local and not allow_local:
        return matte, {**audit, 'reason': 'already_aligned_or_local_error'}, None
    if (after[held_out].mean() > before[held_out].mean()*.8
            or before[held_out].mean()-after[held_out].mean() < .7):
        return matte, {**audit, 'reason': 'insufficient_independent_improvement'}, None
    other = next((k for k in ranked if np.hypot(k[0]-best[0], k[1]-best[1]) >= 6), None)
    if other is not None and candidates[other][0] <= candidates[best][0] + .15:
        return matte, {**audit, 'reason': 'ambiguous_alignment'}, None
    center = np.median(points, axis=0)
    groups = (points[:,0] >= center[0]).astype(int)+2*(points[:,1] >= center[1])
    gains = [float((before-after)[(groups == i)&held_out].mean()) for i in range(4)
             if np.count_nonzero((groups == i)&held_out) >= 8]
    if len(gains) < 3 or min(gains) < -.5 or np.count_nonzero(np.asarray(gains) > .25) < 3:
        return matte, {**audit, 'reason': 'inconsistent_regions'}, None
    matrix = np.float32([[1, 0, best[0]], [0, 1, best[1]]])
    extent = max(1., float(np.ptp(points, axis=0).max()))
    relative = (points-center)/extent

    def transformed(parameters):
        dx,dy,s,r = parameters
        return points+[dx,dy]+np.column_stack((s*relative[:,0]-r*relative[:,1],
                                               r*relative[:,0]+s*relative[:,1]))

    def continuous_distances(p):
        result = np.empty(len(p))
        for bucket in range(8):
            select = buckets == bucket
            result[select] = nd.map_coordinates(field[bucket],
                [p[select,1],p[select,0]], order=1, mode='constant', cval=12)
        return result

    # Translation is the default. A bounded shared scale/rotation is considered
    # only if disjoint source arcs improve too; never fit a free affine shear.
    deformation = extent*.035
    fitted = least_squares(lambda v: continuous_distances(transformed(v))[~held_out],
        [*best, 0., 0.], bounds=([-limit,-limit,-deformation,-deformation],
                                [limit,limit,deformation,deformation]),
        jac='3-point', diff_step=.001, loss='soft_l1', f_scale=1., max_nfev=60)
    refined = np.minimum(continuous_distances(transformed(fitted.x)), 8)
    local_gain = [float((after-refined)[(groups == i)&held_out].mean()) for i in range(4)
                  if np.count_nonzero((groups == i)&held_out) >= 8]
    if (not is_local and refined[held_out].mean() < after[held_out].mean()*.8
            and after[held_out].mean()-refined[held_out].mean() > .15
            and min(local_gain) > -.2):
        dx,dy,s,r = fitted.x
        linear = np.array([[1+s/extent, -r/extent],[r/extent, 1+s/extent]])
        candidate = np.column_stack((linear, center+[dx,dy]-linear@center)).astype(np.float32)
        warped = cv2.warpAffine(original, candidate, (w,h), flags=cv2.INTER_LINEAR)
        old, new = original >= 128, warped >= 128
        if (nd.label(old)[1] == nd.label(new)[1]
                and nd.label(nd.binary_fill_holes(old)&~old)[1] == nd.label(nd.binary_fill_holes(new)&~new)[1]):
            matrix = candidate
            audit.update(method='source_global_similarity',
                         similarityValidation=round(float(refined[held_out].mean()),4))
    moved = cv2.warpAffine(original, matrix, (w,h), flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT)
    # Clipping even a small requested attachment is not a valid registration.
    # Generated black backgrounds contain low-level gray noise. Only coverage
    # above the existing finalizer's noise floor is meaningful content.
    occupied = np.column_stack(np.nonzero(original > 8)[::-1])
    mapped = occupied@matrix[:,:2].T+matrix[:,2]
    if np.any(mapped < -.5) or np.any(mapped > [w-.5,h-.5]):
        return matte, {**audit, 'reason': 'would_clip_content'}, None
    hull = nd.binary_fill_holes(moved >= 128)
    if any(not hull[y,x] or not allowed[y,x] for x,y in object_points):
        return matte, {**audit, 'reason': 'source_anchor_conflict'}, None
    audit.update(applied=True, matrix=matrix.tolist(), regionGains=gains)
    return Image.fromarray(moved), audit, matrix
