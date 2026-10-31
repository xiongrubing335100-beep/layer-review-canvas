"""Bounded joint source registration; observations are not a quality certificate.

RGB supplies observations only. A single forward displacement field transports
the original alpha, including both sides of thin strokes and all counters.
"""
import cv2
import numpy as np
from scipy import ndimage as nd, sparse
from scipy.sparse.linalg import lsqr
from skimage.measure import find_contours


def contour_points(alpha, stride=5):
    contours = find_contours(alpha.astype(float)/255, .5)
    return np.concatenate([c[::stride, ::-1] for c in contours]) if contours else np.empty((0, 2))


def patch_observations(rgb, alpha, radius=8, patch_radius=8):
    """Fit complete alpha patches in TWO dimensions, not along one normal.

    RGB = local background plane + alpha * foreground/background contrast.
    Hessian eigenvectors carry only observed motion to the shared solver. A
    straight edge therefore does not assert that its tangent displacement is 0.
    """
    points = contour_points(alpha)
    h, w = alpha.shape
    p = patch_radius
    y, x = np.mgrid[-p:p+1, -p:p+1].astype(np.float32)
    background = np.stack((np.ones_like(x), x/p, y/p), axis=-1).reshape(-1, 3)
    qbg, _ = np.linalg.qr(background)
    positions, vectors, distances, weights = [], [], [], []
    costs = []
    for point in points:
        cx, cy = np.rint(point).astype(int)
        if min(cx-p-radius, cy-p-radius, w-1-cx-p-radius, h-1-cy-p-radius) < 0:
            continue
        template = alpha[cy-p:cy+p+1, cx-p:cx+p+1].astype(np.float32).ravel()/255
        residual = template-qbg@(qbg.T@template)
        energy = float(residual@residual)
        if energy < 1:
            continue
        # Foreground metal may change color independently of its background.
        # A shared illumination plane incorrectly attracts the contour toward
        # a reflection. Fit two separate local planes instead.
        basis = np.column_stack((background, template[:, None]*background))
        q, r = np.linalg.qr(basis)
        if np.linalg.cond(r) > 1e5:
            continue
        inverse_r = np.linalg.inv(r)
        kernels = [q[:, i].reshape(x.shape).astype(np.float32) for i in range(q.shape[1])]
        boundary = (template > .1).astype(float)
        contrast_gram = (background.T*boundary)@background/max(1, boundary.sum())
        roi = rgb[cy-p-radius:cy+p+radius+1, cx-p-radius:cx+p+radius+1].astype(np.float32)
        error = np.zeros((2*radius+1, 2*radius+1))
        contrast = np.zeros_like(error)
        for channel in range(3):
            values = np.ascontiguousarray(roi[..., channel]-128)
            projections = [cv2.matchTemplate(values, k, cv2.TM_CCORR) for k in kernels]
            total = cv2.matchTemplate(values*values, np.ones_like(x), cv2.TM_CCORR)
            error += np.maximum(0, total-sum(v*v for v in projections))
            coefficients = np.einsum('ij,jhw->ihw', inverse_r[3:], projections)
            contrast += np.einsum('ihw,ij,jhw->hw', coefficients, contrast_gram, coefficients)
        score = error/(template.size*np.maximum(contrast, 100))
        score[contrast < 144] = np.inf
        if not np.isfinite(score).any():
            continue
        by, bx = np.unravel_index(np.argmin(score), score.shape)
        if min(by, bx, 2*radius-by, 2*radius-bx) == 0 or score[by, bx] > .04:
            continue
        if not np.isfinite(score[by-1:by+2, bx-1:bx+2]).all():
            continue
        center = float(score[by, bx])
        gradient = np.array([(score[by, bx+1]-score[by, bx-1])/2,
                             (score[by+1, bx]-score[by-1, bx])/2])
        hessian = np.array([[score[by, bx+1]+score[by, bx-1]-2*center,
                            (score[by+1, bx+1]-score[by+1, bx-1]-score[by-1, bx+1]+score[by-1, bx-1])/4],
                           [0, score[by+1, bx]+score[by-1, bx]-2*center]])
        hessian[1, 0] = hessian[0, 1]
        if not np.isfinite(hessian).all():
            continue
        eigenvalues, eigenvectors = np.linalg.eigh(hessian)
        observed = eigenvalues > max(.0003, eigenvalues[-1]*.04)
        if not observed.any():
            continue
        directions = eigenvectors[:, observed].T
        subpixel = -(directions.T@((directions@gradient)/eigenvalues[observed]))
        subpixel = np.clip(subpixel, -.75, .75)
        displacement = np.array([bx-radius, by-radius])+subpixel
        if bx == radius and by == radius and center < .0001:
            displacement[:] = 0
        # Reject a distinct, equally plausible match along any measured axis.
        sy, sx = np.indices(score.shape)
        delta = np.stack((sx-bx, sy-by), axis=-1)
        separated = np.max(np.abs(delta@directions.T), axis=-1) > 3
        alternative = float(np.min(score[separated])) if separated.any() else np.inf
        if alternative-center < .001:
            continue
        for direction, strength in zip(directions, eigenvalues[observed]):
            positions.append([cx, cy]); vectors.append(direction)
            distances.append(float(displacement@direction))
            weights.append(float(min(4, strength/.01)/(1+center*40)))
        costs.append(center)
    return (np.asarray(positions).reshape(-1, 2), np.asarray(vectors).reshape(-1, 2),
            np.asarray(distances), np.asarray(weights),
            {'sampled': len(points), 'matched': len(costs), 'constraints': len(weights),
             'medianResidual': float(np.median(costs)) if costs else None})


def grid_basis(points, shape, spacing):
    h, w = shape
    gh, gw = int(np.ceil((h-1)/spacing))+1, int(np.ceil((w-1)/spacing))+1
    q = points/spacing
    base = np.minimum(np.floor(q).astype(int), [gw-2, gh-2])
    fraction = q-base
    indices, weights = [], []
    for dy, dx in [(0, 0), (0, 1), (1, 0), (1, 1)]:
        indices.append((base[:, 1]+dy)*gw+base[:, 0]+dx)
        weights.append((fraction[:, 0] if dx else 1-fraction[:, 0])
                       *(fraction[:, 1] if dy else 1-fraction[:, 1]))
    matrix = sparse.csr_matrix((np.array(weights).T.ravel(),
        (np.repeat(np.arange(len(points)), 4), np.array(indices).T.ravel())), shape=(len(points), gh*gw))
    return matrix, (gh, gw)


def fit_shared_field(points, normals, distances, weights, shape, spacing=16):
    basis, grid_shape = grid_basis(points, shape, spacing)
    gh, gw = grid_shape
    n = gh*gw
    cells = np.arange(n).reshape(grid_shape)
    pairs = np.concatenate((np.column_stack((cells[:, :-1].ravel(), cells[:, 1:].ravel())),
                            np.column_stack((cells[:-1].ravel(), cells[1:].ravel()))))
    gradient = sparse.csr_matrix((np.tile([-1., 1.], len(pairs)),
        (np.repeat(np.arange(len(pairs)), 2), pairs.ravel())), shape=(len(pairs), n))
    regularizer = sparse.vstack((.18*gradient, .5*(gradient.T@gradient), .003*sparse.eye(n)))
    observations = sparse.hstack((sparse.diags(normals[:, 0])@basis,
                                  sparse.diags(normals[:, 1])@basis)).tocsr()
    robust = np.ones(len(points))
    for _ in range(3):
        weighted = sparse.diags(np.sqrt(weights*robust))
        design = sparse.vstack((weighted@observations, sparse.block_diag((regularizer, regularizer))))
        rhs = np.r_[np.sqrt(weights*robust)*distances, np.zeros(design.shape[0]-len(points))]
        fitted = lsqr(design, rhs, atol=1e-7, btol=1e-7, iter_lim=500)[0]
        residual = np.abs(observations@fitted-distances)
        robust = np.minimum(1, .75/np.maximum(residual, 1e-9))
    y, x = np.indices(shape, dtype=np.float32)
    return np.stack([nd.map_coordinates(c.reshape(grid_shape), [y/spacing, x/spacing],
                     order=1, mode='nearest') for c in (fitted[:n], fitted[n:])], axis=-1).astype(np.float32)


def invert_field(field):
    y, x = np.indices(field.shape[:2], dtype=np.float32)
    ix, iy = x.copy(), y.copy()
    for _ in range(24):
        sampled = cv2.remap(field, ix, iy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        ix, iy = x-sampled[..., 0], y-sampled[..., 1]
    return ix, iy


def warp_alpha(alpha, field):
    ix, iy = invert_field(field)
    return cv2.remap(alpha, ix, iy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def alpha_transport_integrity(original, alpha, inverse_map, fixed_material=None):
    """Check exact transport in the OUTPUT coordinate frame.

    Thresholded component counts are not invariant under subpixel sampling.
    Compare against the original alpha sampled by the verified map instead:
    cutting a line, deleting a part, smoothing the raster or adding an island
    after that map cannot pass. Semantic source probes separately validate
    object identity/material/counters; this check certifies transport only.
    """
    expected=cv2.remap(original,*inverse_map,cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
    if fixed_material is not None:
        expected[fixed_material]=255
    changed=int(np.count_nonzero(expected!=alpha))
    return {'status':'passed' if changed==0 else 'needs_review',
            'changedAfterTransportPixels':changed,
            'originalBinaryComponents':int(nd.label(original>=128)[1]),
            'transportedBinaryComponents':int(nd.label(expected>=128)[1]),
            'deliveredBinaryComponents':int(nd.label(alpha>=128)[1])}


def bounded_field_update(total, increment, alpha, radius):
    """Backtrack a shared update, keeping every original geometry limit.

    An unconstrained least-squares increment can be too large even when its
    direction is useful. Rejecting the entire first increment then prevents
    any local correction. Compose successively smaller steps instead; clipping,
    invertibility and maximum displacement remain strict. This is numerical
    step control, not source/semantic approval of the resulting silhouette.
    """
    y,x=np.indices(alpha.shape,dtype=np.float32)
    transported=cv2.remap(increment,x+total[...,0],y+total[...,1],
                          cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
    active=alpha>0
    # A small sharp corner must not freeze valid motion elsewhere. Reduce only
    # its smooth neighborhood, then recheck ALL original geometry limits. This
    # does not clip the final field or waive folds; global damping remains the
    # fallback for broad/unsolved violations.
    attenuation=np.ones(alpha.shape,np.float32)
    for iteration in range(12):
        proposed=total+transported*attenuation[...,None]
        dyx,dxx=np.gradient(proposed[...,0]);dyy,dxy=np.gradient(proposed[...,1])
        jacobian=(1+dxx)*(1+dyy)-dxy*dyx
        strain=np.sqrt(dxx*dxx+dyx*dyx+dxy*dxy+dyy*dyy)
        length=np.linalg.norm(proposed,axis=-1)
        outside=active&((x+proposed[...,0]<0)|(x+proposed[...,0]>alpha.shape[1]-1)
                 |(y+proposed[...,1]<0)|(y+proposed[...,1]>alpha.shape[0]-1))
        bad=(jacobian<.35)|(strain>=.75)|(length>radius*1.5)|outside
        if not bad.any():
            return proposed,{'stepScale':1.,'minimumLocalScale':float(attenuation.min()),
                'localDampingIterations':iteration,'minimumJacobian':float(jacobian.min()),
                'maximumGradientNorm':float(strain.max()),'maximumDisplacement':float(length.max()),
                'clippedSourcePixels':0}
        if bad.mean()>.02:break
        neighborhood=nd.gaussian_filter(nd.maximum_filter(bad.astype(np.float32),size=5),3)
        attenuation*=1-.5*neighborhood/max(float(neighborhood.max()),1e-9)
    stats={}
    for scale in (1.,.5,.25,.125,.0625,.03125):
        proposed=total+transported*scale
        dyx,dxx=np.gradient(proposed[...,0]);dyy,dxy=np.gradient(proposed[...,1])
        jacobian=(1+dxx)*(1+dyy)-dxy*dyx
        strain=np.sqrt(dxx*dxx+dyx*dyx+dxy*dxy+dyy*dyy)
        outside=((x+proposed[...,0]<0)|(x+proposed[...,0]>alpha.shape[1]-1)
                 |(y+proposed[...,1]<0)|(y+proposed[...,1]>alpha.shape[0]-1))
        stats={'stepScale':scale,'minimumJacobian':float(jacobian.min()),
               'maximumGradientNorm':float(strain.max()),
               'maximumDisplacement':float(np.linalg.norm(proposed,axis=-1).max()),
               'clippedSourcePixels':int(np.count_nonzero(active&outside))}
        if (stats['minimumJacobian']>=.35 and stats['maximumGradientNorm']<.75
                and stats['maximumDisplacement']<=radius*1.5 and not stats['clippedSourcePixels']):
            return proposed,stats
    return None,stats


def register_source_deformation(rgb, alpha, iterations=3, radius=8, return_mapping=False):
    original = np.asarray(alpha, dtype=np.uint8)
    current = original.copy()
    total = np.zeros((*alpha.shape, 2), np.float32)
    y, x = np.indices(alpha.shape, dtype=np.float32)
    audit = {'applied': False, 'iterations': []}
    for _ in range(iterations):
        positions, directions, distances, weights, stats = patch_observations(rgb, current, radius)
        audit['iterations'].append(stats)
        if len(weights) < 12 or stats['matched'] < stats['sampled']*.2:
            break
        increment = fit_shared_field(positions, directions, distances, weights, alpha.shape)
        proposed,geometry=bounded_field_update(total,increment,original,radius)
        stats.update(geometry)
        if proposed is None:
            stats['rejected'] = 'unsafe_geometry'
            break
        total = proposed
        # Always sample ORIGINAL alpha: repeated interpolation erodes thin parts.
        current = warp_alpha(original, total)
        audit['applied'] = True
    return (current, audit, invert_field(total)) if return_mapping else (current, audit)
