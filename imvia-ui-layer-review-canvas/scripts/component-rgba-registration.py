"""Bounded source-edge coordinate proposals for disconnected RGBA components.

A proposal is not delivery approval: the native entry point additionally
requires whole-RGBA sampling and native-source contour checks. Final source
inspection remains a separate requirement.
"""
import cv2
import numpy as np
from scipy.optimize import minimize, differential_evolution
from scipy import ndimage


def fit_bounded_proposal(score, seeds, bounds, evidence):
    """Keep valid local fits; search the same domain once on evidence failure.

    This only proposes coordinates. The caller still checks geometry, source
    foreground/background separation, overlap, and final native contour.
    """
    proposals = [minimize(score, seed, method="Powell", bounds=bounds,
                          options={"maxiter": 120, "xtol": .0001, "ftol": .0001})
                 for seed in seeds]
    best = min(proposals, key=lambda proposal: float(proposal.fun))
    if evidence(best.x):
        return best
    coarse = differential_evolution(score, bounds, seed=2718, popsize=16,
                                    maxiter=100, init="sobol", polish=False)
    refined = minimize(score, coarse.x, method="Powell", bounds=bounds,
                       options={"maxiter": 120, "xtol": .0001, "ftol": .0001})
    return min((best, coarse, refined), key=lambda proposal: float(proposal.fun))


def fit_components(reference, raw, *, required_region=None, fixed_anchor=None):
    if reference.size != raw.size:
        raise ValueError("NATIVE_COMPONENT_DIMENSIONS")
    source = np.asarray(reference.convert("RGB"))
    values = np.asarray(raw.convert("RGBA"))
    height, width = values.shape[:2]
    count, labels, stats, centers = cv2.connectedComponentsWithStats((values[..., 3] >= 128).astype(np.uint8))
    if not 2 <= count-1 <= 64:
        raise ValueError("NATIVE_COMPONENT_COUNT")
    edges = np.zeros((height, width), np.uint8)
    weak_edges = np.zeros_like(edges)
    for channel in cv2.split(source):
        edges |= cv2.Canny(channel, 25, 70)
        weak_edges |= cv2.Canny(channel, 5, 15)
    # Weak edges need a source step above the local noise floor and continuous
    # support. They propose coordinates only; foreground separation and the
    # native-resolution contour verifier remain independent requirements.
    strength = np.zeros((height, width), np.float32)
    rgb = source.astype(np.int16)
    for dy, dx in ((0, 1), (1, 0)):
        change = np.max(np.abs(rgb[:-dy or None, :-dx or None]-rgb[dy:, dx:]), axis=2)
        strength[:-dy or None, :-dx or None] = np.maximum(
            strength[:-dy or None, :-dx or None], change)
        strength[dy:, dx:] = np.maximum(strength[dy:, dx:], change)
    noise = ndimage.percentile_filter(strength, percentile=25, size=7)
    steps = strength >= np.maximum(3, noise*2)
    weak_edges &= cv2.dilate(steps.astype(np.uint8), np.ones((3, 3), np.uint8))*255
    runs, _ = ndimage.label(weak_edges > 0, structure=np.ones((3, 3)))
    sizes = np.bincount(runs.ravel())
    keep = sizes >= 12
    keep[0] = False
    weak_edges = (keep[runs]*255).astype(np.uint8)
    global_edges = edges if np.count_nonzero(edges) >= 20 else weak_edges
    if np.count_nonzero(global_edges) < 20:
        raise ValueError("NATIVE_COMPONENT_SOURCE_EVIDENCE")
    distance = cv2.distanceTransform(255-global_edges, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    active = set(range(1, count))
    if fixed_anchor is not None:
        fixed_anchor = np.asarray(fixed_anchor, np.float64)
        if (required_region is None or fixed_anchor.shape != (2, 3)
                or not np.isfinite(fixed_anchor).all() or np.linalg.det(fixed_anchor[:, :2]) <= 0):
            raise ValueError("NATIVE_COMPONENT_INVALID_SCOPE")
    if required_region is not None:
        required_region = np.asarray(required_region, bool)
        if required_region.shape != labels.shape or not required_region.any():
            raise ValueError("NATIVE_COMPONENT_INVALID_SCOPE")
        active = set()
        for index in range(1, count):
            x, y, w, h, _ = stats[index]
            # Keep the first proposal's source anchor. A local edit must not
            # establish a different global layout from unrelated content.
            # Include every possible center-relative local adjustment.
            local = .08*(w+h)+min(.04*min(width, height), max(2., .2*max(w, h)))+2
            if fixed_anchor is None:
                raise ValueError("NATIVE_COMPONENT_SCOPE_ANCHOR_REQUIRED")
            corners = cv2.transform(np.array([[[x, y], [x+w, y], [x, y+h], [x+w, y+h]]],
                                             np.float64), fixed_anchor)[0]
            lo, hi = corners.min(axis=0)-local, corners.max(axis=0)+local
            left, top = max(0, int(np.floor(lo[0]))), max(0, int(np.floor(lo[1])))
            right, bottom = min(width, int(np.ceil(hi[0]))), min(height, int(np.ceil(hi[1])))
            if required_region[top:bottom, left:right].any():
                active.add(index)
        if not active:
            raise ValueError("NATIVE_COMPONENT_EMPTY_SCOPE")
    contours, _ = cv2.findContours(np.isin(labels, list(active)).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    all_points = np.concatenate(contours)[:, 0].astype(np.float32)

    def edge_residual(points, matrix):
        q = cv2.transform(points[None], matrix.astype(np.float32))[0]
        return cv2.remap(distance, q[:, 0, None], q[:, 1, None], cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=100).ravel()

    def global_matrix(p):
        return np.array([[p[0], p[1], p[4]], [p[2], p[3], p[5]]])

    def global_score(p):
        return np.minimum(edge_residual(all_points, global_matrix(p)), 20).mean()

    translation = .08*min(width, height)
    bounds = [(.85, 1.15), (-.04, .04), (-.04, .04), (.85, 1.15),
              (-translation, translation), (-translation, translation)]
    if fixed_anchor is None:
        coarse = differential_evolution(global_score, bounds, seed=2718, popsize=8, maxiter=100, polish=False)
        initial_fit = minimize(global_score, coarse.x, method="Powell", bounds=bounds,
                               options={"maxiter": 120, "xtol": .0001, "ftol": .0001})
        initial = global_matrix(initial_fit.x)
    else:
        initial = fixed_anchor
    # Preserve the strong-edge global anchor where available. Local proposals
    # may also use continuous weak source steps, not arbitrary texture.
    primary_distance = distance
    weak_distance = cv2.distanceTransform(255-(edges | weak_edges), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    nearest = ndimage.distance_transform_edt(labels == 0, return_distances=False, return_indices=True)
    owners = labels[tuple(nearest)]
    merged = np.zeros((height, width), np.uint8)
    scope_evidence = (cv2.dilate(required_region.astype(np.uint8), np.ones((17, 17), np.uint8))
                      if required_region is not None else None)

    def local_probes(probes):
        if scope_evidence is None:
            return probes
        anchored = cv2.transform(probes[None], initial.astype(np.float32))[0]
        selected = cv2.remap(scope_evidence, anchored[:, 0, None], anchored[:, 1, None],
                             cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0).ravel() > 0
        return probes[selected]

    transforms, reports = [], []
    for index in range(1, count):
        distance = primary_distance
        if index not in active:
            transforms.append(None)
            reports.append({"component": index, "status": "outside_scoped_reach"})
            continue
        mask = (labels == index).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        points = np.concatenate(contours)[:, 0].astype(np.float32)
        whole_points = points
        points = local_probes(points)
        if scope_evidence is not None and len(points) < 12:
            # Possible transform reach is a conservative broad phase, not
            # proof that this component belongs to the requested edit.
            # With no anchored coverage (including joining context), do not
            # move an unrelated component into the patch merely to fit it.
            anchored_mask = cv2.warpAffine(mask, initial.astype(np.float32),
                                          (width, height), flags=cv2.INTER_NEAREST)
            if len(points) == 0 and not np.any(anchored_mask & scope_evidence):
                transforms.append(None)
                reports.append({"component": index, "status": "outside_anchored_scope"})
                continue
            raise ValueError(f"NATIVE_COMPONENT_SCOPE_EVIDENCE: component {index}")
        center = centers[index]

        def matrix(p):
            delta = np.asarray(p[:4]).reshape(2, 2)
            return np.column_stack((initial[:, :2]+delta, initial[:, 2]+p[4:]-delta@center))

        forbidden = cv2.dilate((merged >= 128).astype(np.uint8), np.ones((3, 3), np.uint8))
        penetration = cv2.distanceTransform(forbidden, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        sy, sx = np.where(mask[::4, ::4])
        support = np.concatenate((whole_points, np.stack((sx*4, sy*4), axis=1))).astype(np.float32)
        colors = values[..., :3][labels == index].astype(np.float32)
        affinity = None
        flat = np.std(colors, axis=0).max() < 35
        palette = None
        if not flat:
            # A two-material glyph is not arbitrary texture. Use a bounded,
            # deterministic palette only when it explains the solid pixels.
            samples = colors[::max(1, len(colors)//4096)]
            axis = int(np.argmax(np.std(samples, axis=0)))
            ordered = samples[np.argsort(samples[:, axis], kind="stable")]
            centers_rgb = ordered[[len(ordered)//10, 9*len(ordered)//10]].copy()
            for _ in range(12):
                distances = np.linalg.norm(samples[:, None]-centers_rgb[None], axis=2)
                assignments = distances.argmin(axis=1)
                if any(not np.any(assignments == k) for k in range(2)):
                    break
                updated = np.stack([np.median(samples[assignments == k], axis=0) for k in range(2)])
                if np.allclose(updated, centers_rgb):
                    break
                centers_rgb = updated
            residual = np.linalg.norm(colors[:, None]-centers_rgb[None], axis=2).min(axis=1)
            if np.quantile(residual, .95) <= 35:
                palette = centers_rgb
        if flat or palette is not None:
            # Flat foreground supplies independent inside/outside color evidence.
            # This affects coordinate scoring only, never the delivered alpha.
            color = np.median(colors, axis=0)
            projected = cv2.transform(points[None], initial.astype(np.float32))[0]
            x0, y0 = np.maximum(0, np.floor(projected.min(axis=0)-8)).astype(int)
            x1, y1 = np.minimum([width, height], np.ceil(projected.max(axis=0)+9)).astype(int)
            patch = source[y0:y1, x0:x1].astype(np.float32)
            if flat and patch.size and np.linalg.norm(patch-color, axis=2).min() > 35:
                # Model color is not source evidence. Recover a local source
                # contrast direction instead of moving toward an unrelated hue.
                perimeter = np.concatenate((patch[0], patch[-1], patch[:, 0], patch[:, -1]))
                background = np.median(perimeter, axis=0)
                contrast = np.linalg.norm(patch-background, axis=2)
                color = np.median(patch[contrast >= np.quantile(contrast, .9)], axis=0)
            affinity = np.minimum.reduce([
                np.linalg.norm(source.astype(np.float32)-entry, axis=2)
                for entry in (palette if palette is not None else [color])
            ])
            local_affinity = affinity[y0:y1, x0:x1]
            color_scale = (max(10., min(100., float(np.quantile(local_affinity, .9)
                                                   - np.quantile(local_affinity, .1))))
                           if local_affinity.size else 100.)
            # Include the solid boundary: eroding scoring probes allows a
            # thin bar to expand while all interior probes still match.
            interior = mask
            exterior = cv2.dilate(mask, np.ones((5, 5), np.uint8))-mask
            iy, ix = np.where(interior)
            oy, ox = np.where(exterior)
            inside_points = np.stack((ix, iy), axis=1).astype(np.float32)[::max(1, len(ix)//1000)]
            outside_points = np.stack((ox, oy), axis=1).astype(np.float32)[::max(1, len(ox)//1000)]
            inside_points, outside_points = local_probes(inside_points), local_probes(outside_points)
            if not len(inside_points) or not len(outside_points):
                affinity = None

        def score(p):
            value = np.minimum(edge_residual(points, matrix(p)), 20).mean()
            if forbidden.any():
                q = cv2.transform(support[None], matrix(p).astype(np.float32))[0]
                value += 5*cv2.remap(penetration, q[:, 0, None], q[:, 1, None], cv2.INTER_LINEAR,
                                    borderMode=cv2.BORDER_CONSTANT, borderValue=100).max()
            if affinity is not None:
                def color_error(probes):
                    q = cv2.transform(probes[None], matrix(p).astype(np.float32))[0]
                    return cv2.remap(affinity, q[:, 0, None], q[:, 1, None], cv2.INTER_LINEAR,
                                     borderMode=cv2.BORDER_CONSTANT, borderValue=441).mean()
                value += (color_error(inside_points)-color_error(outside_points))/color_scale
            return value

        # Translation moves the whole component; tying it to stroke thickness
        # prevents a thin glyph from reaching even a nearby source position.
        # Retain the same canvas-wide cap and geometric/source acceptance gates.
        limit = min(.04*min(width, height), max(2., .2*max(stats[index, 2:4])))
        bounds = [(-.08, .08)]*4+[(-limit, limit)]*2
        identity_seed = np.r_[(np.eye(2)-initial[:, :2]).ravel(),
                              center-(initial[:, :2]@center+initial[:, 2])]
        identity_seed = np.clip(identity_seed, [b[0] for b in bounds], [b[1] for b in bounds])
        # A few pixels can be most of a narrow mark. The canvas-relative
        # ceiling alone would accept a partially overlapping thin component.
        # Keep a rasterization floor, but never allow more than the old ceiling.
        edge_tolerance = min(max(3., .006*min(width, height)),
                             max(1.5, .25*min(stats[index, 2:4])))
        fit = fit_bounded_proposal(score, (np.zeros(6), identity_seed), bounds,
            lambda p: np.quantile(edge_residual(points, matrix(p)), .95)
            <= edge_tolerance)
        if np.quantile(edge_residual(points, matrix(fit.x)), .95) > edge_tolerance:
            distance = weak_distance
            fit = fit_bounded_proposal(score, (fit.x, np.zeros(6), identity_seed), bounds,
                lambda p: np.quantile(edge_residual(points, matrix(p)), .95)
                <= edge_tolerance)
        transform = matrix(fit.x)
        singular = np.linalg.svd(transform[:, :2], compute_uv=False)
        if np.linalg.det(transform[:, :2]) <= 0 or singular.min() < .7 or singular.max() > 1.4:
            raise ValueError("NATIVE_COMPONENT_GEOMETRY")
        error = edge_residual(points, transform)
        if np.quantile(error, .95) > edge_tolerance:
            worst = cv2.transform(points[None], transform.astype(np.float32))[0][int(np.argmax(error))]
            raise ValueError(f"NATIVE_COMPONENT_SOURCE_EVIDENCE: component {index}, "
                             f"p95={np.quantile(error, .95):.3f}, worstReferencePoint={worst.tolist()}")
        foreground_agreement = None
        background_agreement = None
        mean_inside = mean_outside = None
        if affinity is not None:
            probes = cv2.transform(inside_points[None], transform.astype(np.float32))[0]
            interior_error = cv2.remap(
                affinity, probes[:, 0, None], probes[:, 1, None], cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT, borderValue=441).ravel()
            outside_probes = cv2.transform(outside_points[None], transform.astype(np.float32))[0]
            exterior_error = cv2.remap(
                affinity, outside_probes[:, 0, None], outside_probes[:, 1, None], cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT, borderValue=441).ravel()
            # Source shading may differ from flat model RGB. Require a
            # foreground/background separation, not uniform foreground hue.
            # A checkerboard has the same color distribution on both sides.
            foreground_agreement = float(np.mean(interior_error <= 60))
            background_agreement = float(np.mean(exterior_error <= 60))
            mean_inside = float(np.mean(interior_error))
            mean_outside = float(np.mean(exterior_error))
            if mean_outside-mean_inside < 5 or mean_inside > .8*mean_outside:
                raise ValueError(f"NATIVE_COMPONENT_SOURCE_FOREGROUND: component {index}, "
                                 f"agreement={foreground_agreement:.4f}, "
                                 f"outsideAgreement={background_agreement:.4f}, "
                                 f"meanInside={mean_inside:.2f}, meanOutside={mean_outside:.2f}, "
                                 f"medianError={np.median(interior_error):.2f}, color={color.tolist()}")
        component = np.where(owners == index, values[..., 3], 0).astype(np.uint8)
        mapped = cv2.warpAffine(component, transform, (width, height))
        if np.any((mapped >= 128) & (merged >= 128)):
            raise ValueError("NATIVE_COMPONENT_OVERLAP")
        merged = np.maximum(merged, mapped)
        transforms.append(transform)
        reports.append({"component": index, "p95EdgeDistance": float(np.quantile(error, .95)),
                        "foregroundAgreement": foreground_agreement,
                        "backgroundAgreement": background_agreement,
                        "meanInteriorColorError": mean_inside,
                        "meanExteriorColorError": mean_outside,
                        "matrix": transform.tolist()})
    return transforms, initial, {"components": count-1, "method": "bounded_component_source_edges",
                                 "anchorMatrix": initial.tolist(),
                                 "componentEvidence": reports}
