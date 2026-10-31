"""Align a complete generated RGBA to its reference; never deform alpha alone."""
import math
import importlib.util
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

_local_spec = importlib.util.spec_from_file_location('native_local_registration', Path(__file__).with_name('native-local-registration.py'))
_local = importlib.util.module_from_spec(_local_spec)
_local_spec.loader.exec_module(_local)


def estimate_alignment(reference, raw, source_crop=None, mapping=None, *, defer_component_contour=False,
                       required_region=None, component_anchor=None):
    if required_region is not None:
        if not defer_component_contour or source_crop is None or mapping is None:
            raise ValueError("NATIVE_COMPONENT_INVALID_SCOPE")
        # Do not let irrelevant second-image content steer a global feature
        # match. The complete initial image still uses ordinary registration.
        return estimate_component_alignment(reference, raw, source_crop, mapping,
                                            defer_contour=True, required_region=required_region,
                                            component_anchor=component_anchor)
    source, generated = np.asarray(reference.convert('RGBA')), np.asarray(raw.convert('RGBA'))
    # Transparent RGB is undefined visual data. Detect on visible composites,
    # not hidden RGB; different neutral backdrops preserve dark/light contours.
    accepted = []
    errors = []
    for background in (0, 128, 255):
        def visible_gray(rgba):
            alpha = rgba[..., 3:4].astype(np.float32) / 255
            rgb = np.rint(rgba[..., :3] * alpha + background * (1-alpha)).astype(np.uint8)
            return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        first, second = visible_gray(source), visible_gray(generated)
        for normalized in (False, True):
            def feature_image(gray):
                if not normalized:
                    return gray
                values = gray.astype(np.float32)
                sigma = max(4, min(gray.shape)/32)
                residual = values - cv2.GaussianBlur(values, (0, 0), sigma)
                deviation = np.sqrt(cv2.GaussianBlur(residual*residual, (0, 0), sigma) + 25)
                return np.clip(128 + 32*residual/deviation, 0, 255).astype(np.uint8)
            try:
                matrix, audit = estimate_feature_alignment(feature_image(first), feature_image(second), generated[..., 3])
                audit['featureBackground'] = background
                audit['transparentRgbIgnored'] = True
                audit['illuminationNormalized'] = normalized
                accepted.append((matrix, audit))
            except ValueError as error:
                errors.append(error)
    if not accepted:
        # A single similarity cannot represent independently shifted regions.
        # Fit only reciprocal, locally consistent source correspondences, then
        # validate held-out points and the complete coordinate field geometry.
        def neutral_gray(rgba):
            alpha=rgba[...,3:4].astype(np.float32)/255
            return cv2.cvtColor(np.rint(rgba[...,:3]*alpha+128*(1-alpha)).astype(np.uint8),cv2.COLOR_RGB2GRAY)
        try:
            return _local.estimate_local_alignment(neutral_gray(source),neutral_gray(generated),generated[...,3])
        except ValueError:
            pass
        if source_crop is not None and mapping is not None:
            try:
                return estimate_sparse_alignment(reference, raw, source_crop, mapping)
            except ValueError:
                return estimate_component_alignment(reference, raw, source_crop, mapping,
                                                    defer_contour=defer_component_contour)
        raise errors[-1]
    return max(accepted, key=lambda result: (result[1]['inliers'], -result[1]['p95Error']))


def estimate_component_alignment(reference, raw, source_crop, mapping, *, defer_contour=False,
                                 required_region=None, component_anchor=None):
    """Disconnected low-feature blocks, verified in native source coordinates."""
    spec = importlib.util.spec_from_file_location(
        'native_component_fit', Path(__file__).with_name('component-rgba-registration.py'))
    component = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(component)
    reference_scope = None
    if required_region is not None:
        if not defer_contour:
            raise ValueError("NATIVE_COMPONENT_INVALID_SCOPE")
        source_scope = np.asarray(required_region, bool)
        if source_scope.shape != (source_crop.height, source_crop.width):
            raise ValueError("NATIVE_COMPONENT_INVALID_SCOPE")
        region = mapping['contentRegion']
        reference_scope = np.zeros((reference.height, reference.width), np.uint8)
        reference_scope[region['y']:region['y']+region['height'], region['x']:region['x']+region['width']] = cv2.resize(
            source_scope.astype(np.float32), (region['width'], region['height']), interpolation=cv2.INTER_AREA) > 0
    transforms, anchor, audit = component.fit_components(reference, raw, required_region=reference_scope,
                                                         fixed_anchor=component_anchor)
    coordinate_map = {'kind': 'components', 'transforms': transforms, 'anchor': anchor,
                      'scopedComponents': required_region is not None,
                      'requiredRegion': required_region}
    mapped = np.asarray(sample_aligned(raw, coordinate_map, mapping, source_crop.size))
    spec = importlib.util.spec_from_file_location(
        'component_source_evidence', Path(__file__).with_name('source-guided-matte.py'))
    evidence = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evidence)
    contour, _ = evidence.source_contour_evidence(
        np.asarray(source_crop.convert('RGB')), mapped[..., 3] >= 128,
        np.zeros(mapped.shape[:2], bool), material=True, alpha=mapped[..., 3])
    verified = contour['boundaryMatchRatio'] >= .9 and contour['longestUnsupportedRun'] <= 12
    if not verified and not defer_contour:
        raise ValueError('NATIVE_COMPONENT_SOURCE_CONTOUR')
    return coordinate_map, {**audit, 'status': 'passed' if verified and required_region is None else 'pending_scoped_merge', 'sourceContour': contour,
                            'transparentRgbIgnored': True}


def estimate_sparse_alignment(reference, raw, source_crop, mapping):
    """Low-texture marks: propose a whole-RGBA transform, verify on native source.

    Edge-density alone can align a mark to background texture. Contrast provides
    a separate initialization; every boundary must then pass source evidence.
    No pixels or thresholds in the source contour verifier are changed here.
    """
    from scipy.optimize import minimize
    original = np.asarray(raw.convert('RGBA'))
    colors = original[..., :3][original[..., 3] > 200]
    if not len(colors) or np.max(np.std(colors.astype(float), axis=0)) > 35:
        raise ValueError('NATIVE_ALIGNMENT_INSUFFICIENT_MATCHES')
    factor = 384 / max(reference.size)
    size = tuple(round(v*factor) for v in reference.size)
    rgb = cv2.resize(np.asarray(reference.convert('RGB')), size, interpolation=cv2.INTER_AREA)
    alpha = cv2.resize(original[...,3], size, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY).astype(np.float32)
    if float(np.median(colors)) < 128:
        gray = 255-gray
    edges = np.zeros(alpha.shape,np.uint8)
    for channel in cv2.split(rgb):
        edges |= cv2.Canny(channel,40,100)
    distance = cv2.distanceTransform(255-edges,cv2.DIST_L2,cv2.DIST_MASK_PRECISE)
    contours,_ = cv2.findContours((alpha>128).astype(np.uint8),cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise ValueError('NATIVE_ALIGNMENT_NOT_FOUND')
    points = np.concatenate(contours)[:,0,:].astype(np.float32)
    def score(p):
        scale,angle,tx,ty=p
        c,s=np.cos(angle)*scale,np.sin(angle)*scale
        q=(points@np.array([[c,s],[-s,c]],np.float32)+[tx,ty]).astype(np.float32)
        return np.minimum(cv2.remap(distance,q[:,0,None],q[:,1,None],cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT,borderValue=30),12).mean()
    starts=[]
    # Sparse generated marks can be enlarged inside the otherwise correct
    # reference canvas. Search a wider similarity range, but keep independent
    # native-source contour evidence and ambiguity checks unchanged.
    minimum_scale, maximum_scale = .5, 2.
    for scale in np.arange(minimum_scale,maximum_scale+.001,.025):
        scale=float(np.clip(scale,minimum_scale,maximum_scale))
        template=cv2.resize((alpha>128).astype(np.uint8),None,fx=scale,fy=scale,interpolation=cv2.INTER_NEAREST)
        yy,xx=np.where(template)
        if not len(xx): continue
        x0,y0=max(0,xx.min()-4),max(0,yy.min()-4)
        crop=template[y0:yy.max()+5,x0:xx.max()+5]
        if crop.shape[0]>size[1] or crop.shape[1]>size[0]: continue
        outside=(cv2.dilate(crop,np.ones((7,7),np.uint8))-crop).astype(np.float32)
        if not outside.sum(): continue
        kernel=(crop.astype(np.float32)/crop.sum()-outside/outside.sum()).astype(np.float32)
        response=cv2.matchTemplate(gray,kernel,cv2.TM_CCORR)
        _,value,_,position=cv2.minMaxLoc(response)
        # A repeated mark is not evidence of which source instance was selected.
        competitors=response.copy()
        radius=max(4,min(crop.shape)//4)
        px,py=position
        competitors[max(0,py-radius):py+radius+1,max(0,px-radius):px+radius+1]=-np.inf
        if np.max(competitors)>=value*.9: continue
        if value>=20: starts.append((value,[scale,0,position[0]-x0,position[1]-y0]))
    spec=importlib.util.spec_from_file_location('native_contour_evidence',Path(__file__).with_name('source-guided-matte.py'))
    evidence=importlib.util.module_from_spec(spec);spec.loader.exec_module(evidence)
    accepted=[]
    for _,start in sorted(starts,reverse=True)[:3]:
        fit=minimize(score,start,method='Powell',bounds=[(max(minimum_scale,start[0]-.03),min(maximum_scale,start[0]+.03)),
                     (-.04,.04),(start[2]-3,start[2]+3),(start[3]-3,start[3]+3)],
                     options={'maxiter':100,'xtol':.0001,'ftol':.0001})
        scale,angle,tx,ty=fit.x
        c,s=np.cos(angle)*scale,np.sin(angle)*scale
        matrix=np.array([[c,-s,tx/factor],[s,c,ty/factor]])
        if np.linalg.norm(matrix[:,2])>.25*math.hypot(*reference.size): continue
        mapped=np.asarray(sample_aligned(raw,matrix,mapping,source_crop.size))[...,3]
        audit,_=evidence.source_contour_evidence(np.asarray(source_crop.convert('RGB')),mapped>=128,
                    np.zeros(mapped.shape,bool),material=True,alpha=mapped)
        if audit['boundaryMatchRatio']>=.9 and audit['longestUnsupportedRun']<=12:
            accepted.append((float(fit.fun),matrix,audit))
    if not accepted:
        raise ValueError('NATIVE_ALIGNMENT_UNRELIABLE')
    _,matrix,audit=min(accepted,key=lambda item:item[0])
    return matrix,{'status':'passed','method':'source_contrast_contour_similarity',
                   'matrix':matrix.tolist(),'sourceContour':audit,'transparentRgbIgnored':True}


def estimate_feature_alignment(source_gray, generated_gray, alpha):
    detector = cv2.SIFT_create(nfeatures=6000)
    first, descriptors = detector.detectAndCompute(source_gray, None)
    second, proposed = detector.detectAndCompute(generated_gray, (alpha > 200).astype(np.uint8) * 255)
    if descriptors is None or proposed is None:
        raise ValueError('NATIVE_ALIGNMENT_INSUFFICIENT_FEATURES')
    pairs = cv2.BFMatcher().knnMatch(proposed, descriptors, k=2)
    matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < .7 * pair[1].distance]
    if len(matches) < 20:
        raise ValueError('NATIVE_ALIGNMENT_INSUFFICIENT_MATCHES')
    p = np.float32([second[m.queryIdx].pt for m in matches])
    q = np.float32([first[m.trainIdx].pt for m in matches])
    cv2.setRNGSeed(2718)
    matrix, inliers = cv2.estimateAffinePartial2D(p, q, method=cv2.RANSAC, ransacReprojThreshold=3,
                                                maxIters=5000, confidence=.999, refineIters=20)
    if matrix is None or inliers is None:
        raise ValueError('NATIVE_ALIGNMENT_NOT_FOUND')
    selected = inliers.ravel() > 0
    errors = np.linalg.norm(cv2.transform(p[None], matrix)[0] - q, axis=1)[selected]
    scale = math.hypot(matrix[0, 0], matrix[1, 0])
    angle = math.degrees(math.atan2(matrix[1, 0], matrix[0, 0]))
    height, width = alpha.shape
    # Distributed evidence is required: one tiny logo cannot align a whole scene.
    span = np.ptp(p[selected], axis=0) / [width, height]
    if (selected.sum() < 20 or selected.mean() < .5 or min(span) < .2
            or not .7 <= scale <= 1.4 or abs(angle) > 5
            or np.linalg.norm(matrix[:, 2]) > .25 * math.hypot(width, height)
            or np.quantile(errors, .95) > 3):
        raise ValueError('NATIVE_ALIGNMENT_UNRELIABLE')
    return matrix, {'status': 'passed', 'method': 'source_feature_similarity',
                    'matches': len(matches), 'inliers': int(selected.sum()),
                    'medianError': float(np.median(errors)), 'p95Error': float(np.quantile(errors, .95)),
                    'scale': scale, 'rotationDegrees': angle, 'matrix': matrix.tolist()}


def sample_aligned(raw, matrix, mapping, expected_size):
    """Compose registration and reference inverse mapping before sampling raw."""
    if isinstance(matrix, dict) and matrix.get('kind') == 'components':
        spec = importlib.util.spec_from_file_location(
            'native_component_sampler', Path(__file__).with_name('component-rgba-sampling.py'))
        sampler = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sampler)
        return sampler.sample_components(raw, matrix['transforms'], mapping, expected_size,
                                         residual_transform=matrix['anchor'],
                                         allow_partial=matrix.get('scopedComponents', False),
                                         required_region=matrix.get('requiredRegion'))
    region = mapping['contentRegion']
    width, height = expected_size
    local_map = matrix if isinstance(matrix,dict) else None
    inverse = local_map['inverse'] if local_map else cv2.invertAffineTransform(matrix)
    values = np.asarray(raw.convert('RGBA'), dtype=np.float32).copy()
    values[..., :3] *= values[..., 3:4] / 255
    result = np.empty((height, width, 4), np.uint8)
    scale = local_map['scale'] if local_map else math.hypot(matrix[0,0],matrix[1,0])
    footprint = max(region['width'] / width, region['height'] / height) / scale
    samples = min(4, max(1, math.ceil(footprint)))
    for top in range(0, height, 64):
        bottom = min(height, top + 64)
        yy, xx = np.mgrid[top:bottom, :width].astype(np.float32)
        total = np.zeros((bottom-top, width, 4), np.float32)
        for sy in range(samples):
            for sx in range(samples):
                rx = region['x'] + (xx + (sx+.5)/samples) * region['width']/width - .5
                ry = region['y'] + (yy + (sy+.5)/samples) * region['height']/height - .5
                mx = inverse[0,0]*rx + inverse[0,1]*ry + inverse[0,2]
                my = inverse[1,0]*rx + inverse[1,1]*ry + inverse[1,2]
                if local_map:
                    mapped=_local.map_points(local_map,np.stack([rx,ry],axis=-1))
                    mx,my=mapped[...,0],mapped[...,1]
                total += cv2.remap(values, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        total /= samples*samples
        alpha = total[..., 3:4]
        total[..., :3] = np.divide(total[..., :3]*255, alpha, out=np.zeros_like(total[..., :3]), where=alpha>0)
        result[top:bottom] = np.rint(np.clip(total, 0, 255)).astype(np.uint8)
    return Image.fromarray(result)
