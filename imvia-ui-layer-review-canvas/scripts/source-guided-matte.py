"""Refine a semantic silhouette against frozen source pixels, never generated RGB.

The model identifies the object; it is not a pixel-accurate segmentation provider.
Use source-color recovery only where its assumptions are supported; otherwise
refine a bounded contour band. Unsupported geometry fails closed.
Uses OpenCV/numpy/scipy already pinned by requirements-rmbg.lock.
"""
import numpy as np
import cv2
import importlib.util
from pathlib import Path
from scipy import ndimage as nd
from scipy.optimize import least_squares
from scipy.special import ndtr
from PIL import Image


def fail(message):
    raise ValueError("MATTE_SOURCE_GEOMETRY_MISMATCH: " + message)


def component_seeds(foreground, distance, radius):
    seeds = foreground & (distance > radius)
    labels, count = nd.label(foreground)
    # Erosion must not erase a thin stroke or a small, disconnected decoration.
    for label, box in enumerate(nd.find_objects(labels), 1):
        if box is None:
            continue
        component = labels[box] == label
        if not np.any(seeds[box] & component):
            local_distance = distance[box]
            seeds[box] |= component & (local_distance == local_distance[component].max())
    return seeds, labels, count


def alpha_contour_integrity(expected, alpha):
    """Check the delivered alpha, not just the intermediate segmentation."""
    visible = np.asarray(alpha) >= 128
    counters = nd.binary_fill_holes(expected) & ~expected
    changed = int(np.count_nonzero(visible != expected))
    lost = int(np.count_nonzero(counters & visible))
    return {"status": "passed" if changed == 0 and lost == 0 else "needs_review",
            "changedByAlphaRecoveryPixels": changed, "lostCounterPixels": lost,
            "counterCount": int(nd.label(counters)[1])}


def source_color_matte(rgb, foreground, radius, scope):
    """Solve alpha only when the source supports a single F/B color mixture.

    Unlike a gradient threshold, this uses the full color transition, including
    low-contrast and soft edges. Do not apply this model to textured photographs.
    Semantic scope still comes from the proposal; other islands are NOT added.
    """
    color = rgb.astype(np.float32)
    outside = nd.distance_transform_edt(~foreground)
    background_samples = color[(outside > radius) & scope]
    if len(background_samples) < 8:
        return None
    background = np.median(background_samples, axis=0)
    background_error = np.max(np.abs(background_samples - background), axis=1)
    if np.mean(background_error <= 2) < 0.8:
        return None
    samples = color[foreground]
    distance = np.linalg.norm(samples - background, axis=1)
    # A filled-in hole must not make the median foreground become background.
    foreground_color = np.median(samples[distance >= np.percentile(distance, 90)], axis=0)
    delta = foreground_color - background
    denominator = float(np.dot(delta, delta))
    if denominator < 6 ** 2:
        return None
    mixture = np.sum((color - background) * delta, axis=2) / denominator
    projected = background + np.clip(mixture, 0, 1)[..., None] * delta
    residual = np.max(np.abs(color - projected), axis=2)
    if np.mean((residual[scope] <= 2) & (mixture[scope] >= -0.02) & (mixture[scope] <= 1.02)) < 0.995:
        return None
    alpha = np.rint(np.clip(mixture, 0, 1) * 255).astype(np.uint8)
    alpha[~scope] = 0
    # A grayscale material/shadow also lies on a color line. It is NOT evidence
    # of transparency deep inside an opaque object. Use the bounded route there.
    interior = nd.distance_transform_edt(alpha >= 128) > radius
    if np.any(interior & (alpha > 2) & (alpha < 253)):
        return None
    labels, count = nd.label(alpha >= 128)
    selected = np.unique(labels[foreground])
    selected = selected[selected != 0]
    if not len(selected):
        return None
    visible = np.isin(labels, selected)
    # Bound growth to the original proposal; never silently select a remote item.
    if np.any(visible & (outside > radius)):
        return None
    old_components, old_count = nd.label(foreground)
    if len(np.unique(old_components[visible])) - int(np.any(old_components[visible] == 0)) != old_count:
        return None
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    omitted = np.setdiff1d(np.flatnonzero(sizes[1:] >= 4) + 1, selected)
    _, nearest = nd.distance_transform_edt(labels == 0, return_indices=True)
    alpha[~np.isin(labels[tuple(nearest)], selected)] = 0
    alpha[outside > radius] = 0
    visible = alpha >= 128
    boundary = visible & ~nd.binary_erosion(visible)
    audit = {"policyVersion": 7, "method": "source_guided_matte", "evidenceMethod": "source_color_projection",
             "contourIntegrity": alpha_contour_integrity(visible, alpha),
             "status": "needs_review" if len(omitted) else "passed",
             "reviewReasons": ["POSSIBLE_MISSING_COMPONENTS"] if len(omitted) else [],
             "semanticCompleteness": "requires_user_review", "unselectedComponentCount": len(omitted),
             "radiusPixels": radius, "changedPixels": int(np.count_nonzero(visible != foreground)),
             "changedAreaRatio": round(float(np.count_nonzero(visible != foreground) / foreground.sum()), 6),
             "boundaryMatchRatio": 1.0, "boundaryPixels": int(boundary.sum()),
             "longestUnsupportedRun": 0, "maximumUnsupportedRun": 12, "uncertainRegions": [],
             "minimumRatio": 0.90, "colorResidualP99": float(np.percentile(residual[scope], 99)),
             "sourceContrast": round(float(np.sqrt(denominator)), 6)}
    return Image.fromarray(alpha), audit, foreground_color


def prepare_registered_matte(source, matte, scope=None, semantic_topology=None):
    # A semantic white-on-black proposal can contain isolated 1/255 black
    # background noise. It is not a selected translucent object. Keeping it at
    # the crop border makes a safe local transform look like source clipping.
    # Do not threshold AA tails connected to a real foreground component.
    original = np.asarray(matte.convert('L'))
    connected = nd.binary_propagation(original >= 128, mask=original > 0,
                                      structure=np.ones((3,3)))
    noise = ~connected & (original > 0) & (original <= 8)
    if noise.any():
        cleaned = original.copy(); cleaned[noise] = 0
        matte = Image.fromarray(cleaned)
    spec = importlib.util.spec_from_file_location('matte_registration', Path(__file__).with_name('matte-registration.py'))
    registration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registration)
    # Geometry is computed identically before and after semantic inspection.
    # Source anchors validate the result below; they cannot change the frame in
    # which the executor just classified raw hole IDs.
    aligned, alignment, transform = registration.register_matte(source, matte, scope)
    alignment['removedBackgroundNoisePixels'] = int(noise.sum())
    if (not alignment['applied'] and alignment.get('reason') == 'already_aligned_or_local_error'
            and any(alignment.get('offsetPixels', []))
            and alignment['validationBefore']-alignment['validationAfter'] >= .7):
        # Small shared offsets must not be repaired as independent movements of
        # both sides of a thin ring. The registration score alone is insufficient
        # (it also sees internal highlights), so require independent source
        # evidence before accepting its rigid, topology-preserving translation.
        rgb = np.asarray(source.convert('RGB'))
        original = np.asarray(matte.convert('L'))
        before, _ = source_contour_evidence(rgb, original >= 128, np.zeros(original.shape, bool),
                                           material=True, alpha=original)
        if before['boundaryMatchRatio'] < .9 or before['longestUnsupportedRun'] > 12:
            candidate, checked_alignment, checked_transform = registration.register_matte(
                source, matte, scope, allow_local=True)
            if checked_alignment['applied']:
                value = np.asarray(candidate)
                after, _ = source_contour_evidence(rgb, value >= 128, np.zeros(value.shape, bool),
                                                  material=True, alpha=value)
                if after['boundaryMatchRatio'] >= .9 and after['longestUnsupportedRun'] <= 12:
                    aligned, transform = candidate, checked_transform
                    alignment = {**checked_alignment, 'sourceCoverageVerified': True}
    if semantic_topology is None:
        return aligned, alignment, None, None, None
    spec = importlib.util.spec_from_file_location('semantic_matte', Path(__file__).with_name('semantic-matte.py'))
    semantic = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(semantic)
    aligned, audit, evidence = semantic.prepare_topology(source, matte, semantic_topology, scope, transform)
    return aligned, alignment, semantic, audit, evidence


def refine_source_matte(source, matte, category, scope=None, recover_foreground=False, semantic_topology=None):
    if source.size != matte.size:
        raise ValueError("MATTE_DIMENSIONS_MISMATCH")
    if source.width * source.height > 4_000_000:
        raise ValueError("MATTE_REFINEMENT_SIZE_LIMIT: select a region below 4 million pixels")
    matte, alignment, semantic_module, semantic_audit, semantic_evidence = prepare_registered_matte(
        source, matte, scope, semantic_topology)

    def finish(mask, audit, recovered):
        audit['globalRegistration'] = alignment
        if semantic_module is not None:
            final_alpha = np.asarray(mask)
            if scope is not None:
                final_alpha = np.minimum(final_alpha, np.asarray(scope))
            final_alpha = np.rint(final_alpha.astype(float) * np.asarray(source.convert('RGBA'))[..., 3] / 255).astype(np.uint8)
            semantic_module.verify_topology(final_alpha, semantic_audit, semantic_evidence)
            audit['semanticTopology'] = semantic_audit
            audit['semanticCompleteness'] = 'executor_source_reviewed'
            if semantic_topology['profile'] == 'material_composite':
                missing = unmodeled_source_counters(np.asarray(source.convert('RGB')), final_alpha,
                                                   semantic_evidence)
                audit['sourceInteriorCheck'] = {'possibleMissingCounters': missing}
                if missing:
                    audit['status'] = 'needs_review'
                    audit['reviewReasons'] = list(dict.fromkeys(
                        [*audit.get('reviewReasons', []), 'POSSIBLE_MISSING_COUNTERS']))
        return (mask, audit, recovered) if recover_foreground else (mask, audit)
    foreground = np.asarray(matte.convert("L")) >= 128
    allowed = np.ones_like(foreground) if scope is None else np.asarray(scope) > 0
    foreground &= allowed
    if not foreground.any() or foreground.all():
        fail("matte must contain both foreground and background")
    if semantic_module is not None and semantic_topology['profile'] == 'material_composite':
        # A source-verified silhouette is not a proposal to re-segment. Global
        # color clustering can move it onto internal reflections, despite the
        # original coverage being correct. Check before destructive refinement;
        # independent semantic verification still runs through finish().
        original = np.asarray(matte.convert('L'))
        rgb = np.asarray(source.convert('RGB'))
        if not np.any((original > 0) & ~allowed):
            measurement, _ = source_contour_evidence(
                rgb, original >= 128, np.zeros_like(foreground), material=True, alpha=original)
            if measurement['boundaryMatchRatio'] >= .9 and measurement['longestUnsupportedRun'] <= 12:
                colors = rgb.copy()
                samples, _, _ = component_seeds(foreground, nd.distance_transform_edt(foreground), 1.5)
                nearest = nd.distance_transform_edt(~samples, return_distances=False, return_indices=True)
                soft = (original > 0) & (original < 255)
                colors[soft] = rgb[tuple(nearest)][soft]
                audit = {'policyVersion': 7, 'method': 'source_guided_matte',
                         'evidenceMethod': 'bounded_shape', 'sourceCoveragePreserved': True, 'status': 'passed',
                         'reviewReasons': [], **measurement, 'minimumRatio': .9,
                         'maximumUnsupportedRun': 12, 'changedPixels': 0, 'changedAreaRatio': 0.,
                         'contourIntegrity': alpha_contour_integrity(foreground, original),
                         'localContourRepair': {'applied': False, 'changedPixels': 0}}
                return finish(matte, audit, Image.fromarray(colors))
    radius = max(6, min(12, round(min(matte.size) * 0.02)))
    projected = source_color_matte(np.asarray(source.convert("RGB")), foreground, radius, allowed)
    protected_material = semantic_evidence[1] if semantic_module is not None else None
    if projected is not None and protected_material is not None and np.any(np.asarray(projected[0])[protected_material] < 255):
        projected = None
    if projected is not None:
        mask, audit, color = projected
        recovered = np.asarray(source.convert("RGB")).copy()
        edge = (np.asarray(mask) > 0) & (np.asarray(mask) < 255)
        recovered[edge] = np.rint(color).astype(np.uint8)
        return finish(mask, audit, Image.fromarray(recovered))
    material_profile = semantic_module is not None and semantic_topology['profile'] == 'material_composite'
    if material_profile:
        registered = source_joint_registration(source, matte, allowed, semantic_module, semantic_audit, semantic_evidence)
        if registered is not None:
            mask, audit, recovered, semantic_audit, semantic_evidence = registered
            return finish(mask, audit, recovered)
    mask, audit, recovered = refine_bounded_matte(source, matte, category,
        protected_material=protected_material, material=material_profile)
    if (semantic_module is not None and semantic_topology['profile'] == 'material_composite'
            and audit['status'] != 'passed'):
        assembly = source_assembly_matte(source, matte, allowed, semantic_evidence)
        if assembly is None:
            assembly = source_registered_assembly(source, matte, allowed, semantic_evidence)
        if assembly is not None:
            candidate_mask, candidate_audit, candidate_rgb = assembly
            # This path is a separate source segmentation, not a relaxation of
            # the existing contour score. Semantic verification is independent.
            semantic_module.verify_topology(np.asarray(candidate_mask), dict(semantic_audit), semantic_evidence)
            mask, audit, recovered = candidate_mask, candidate_audit, candidate_rgb
        if audit['status'] != 'passed':
            registered = source_joint_registration(source, matte, allowed, semantic_module,
                semantic_audit, semantic_evidence, coupled=True)
            if registered is not None:
                mask, audit, recovered, semantic_audit, semantic_evidence = registered
                return finish(mask, audit, recovered)
    audit.update(policyVersion=7, method="source_guided_matte", evidenceMethod="bounded_shape",
                 semanticCompleteness="requires_user_review")
    return finish(mask, audit, recovered)


def source_joint_registration(source, matte, allowed, semantic_module, semantic_audit, semantic_evidence, coupled=False):
    """Correct local displacement before color segmentation can split a part.

    The shared field is only a proposal. Existing source evidence, source scope,
    component ownership, transported counters and fixed source anchors must all
    pass before the alpha can enter the renderer. RGB is never warped.
    """
    spec = importlib.util.spec_from_file_location('matte_correspondence', Path(__file__).with_name('matte-correspondence.py'))
    joint = importlib.util.module_from_spec(spec); spec.loader.exec_module(joint)
    rgb = np.asarray(source.convert('RGB'))
    original = np.asarray(matte.convert('L'))
    radius = max(8, min(16, round(min(matte.size)*.02)))
    if coupled:
        alpha, geometry, inverse_map = coupled_source_deformation(rgb, original)
    else:
        alpha, geometry, inverse_map = joint.register_source_deformation(rgb, original, radius=radius, return_mapping=True)
    # These are source-confirmed opaque pixels, not points on the generated
    # mask. They stay fixed while generated counter identities follow the map.
    # Revalidate the final alpha AFTER reinstating this constraint.
    restored = semantic_evidence[1]
    restored_count = int(np.count_nonzero(alpha[restored] != 255))
    alpha[restored] = 255
    geometry['fixedSourceMaterialPixels'] = restored_count
    if not geometry['applied'] or np.any((alpha > 0) & ~allowed):
        return None
    visible = alpha >= 128
    original_visible = original >= 128
    if coupled:
        transport = joint.alpha_transport_integrity(original,alpha,inverse_map,restored)
        if transport['status'] != 'passed':
            return None
        geometry['alphaTransport'] = transport
    elif nd.label(visible)[1] != nd.label(original_visible)[1]:
        return None
    measurement, _ = source_contour_evidence(rgb, visible, np.zeros_like(visible), material=True, alpha=alpha)
    if measurement['boundaryMatchRatio'] < .9 or measurement['longestUnsupportedRun'] > 12:
        return None
    try:
        moved_audit, moved_evidence = semantic_module.transport_counter_evidence(semantic_audit, semantic_evidence, inverse_map)
        semantic_module.verify_topology(alpha, moved_audit, moved_evidence)
    except ValueError:
        return None
    # Retain source colors at their original coordinates. Only antialiased edge
    # RGB is decontaminated, using actual nearby source foreground pixels.
    colors = rgb.copy()
    samples, _, _ = component_seeds(visible, nd.distance_transform_edt(visible), 1.5)
    nearest = nd.distance_transform_edt(~samples, return_distances=False, return_indices=True)
    soft = (alpha > 0) & (alpha < 255)
    colors[soft] = rgb[tuple(nearest)][soft]
    changed = int(np.count_nonzero(original_visible != visible))
    audit = {'policyVersion': 7, 'method': 'source_guided_matte', 'evidenceMethod': 'bounded_shape',
             'status': 'passed', 'reviewReasons': [], **measurement, 'minimumRatio': .9,
             'maximumUnsupportedRun': 12, 'changedPixels': changed,
             'changedAreaRatio': round(changed/max(1, original_visible.sum()), 6),
             'contourIntegrity': alpha_contour_integrity(visible, alpha),
             'localContourRepair': {'applied': True,
                                    'method': 'coupled_source_registration' if coupled else 'joint_source_registration',
                                    'changedPixels': changed, 'geometry': geometry}}
    return Image.fromarray(alpha), audit, Image.fromarray(colors), moved_audit, moved_evidence


def coupled_source_deformation(rgb, original, iterations=20, radius=24):
    """Pair narrow edges, then solve local offsets in one bounded coordinate map.

    Source correspondence drives this optimizer; its fitting score is not an
    independent accuracy guarantee. The caller must also check source scope,
    semantic topology, pixel identity and the final full-resolution output.
    """
    spec=importlib.util.spec_from_file_location('matte_correspondence',Path(__file__).with_name('matte-correspondence.py'))
    joint=importlib.util.module_from_spec(spec);spec.loader.exec_module(joint)
    source_alpha=original
    observations=register_source_contours(rgb,original,radius,original>=128,
        source_search=True,return_observations=True)
    total=np.zeros((*original.shape,2),np.float32)
    if not observations:return original.copy(),{'applied':False},joint.invert_field(total)
    points,normals,distances=(np.concatenate([v[i] for v in observations]) for i in range(3))
    increment=joint.fit_shared_field(points,normals,distances,np.ones(len(points)),original.shape)
    proposed,geometry=joint.bounded_field_update(total,increment,original,radius)
    if proposed is None:return original.copy(),{'applied':False,'geometry':geometry},joint.invert_field(total)
    total=proposed;current=joint.warp_alpha(original,total)
    records=[geometry]
    measurement,unknown=source_contour_evidence(rgb,current>=128,np.zeros(original.shape,bool),material=True,alpha=current)
    # Precise photometric patches work well where both surfaces are smooth.
    # Keep that proposal only if the entire source audit improves, never merely
    # because the patch fit has a high confidence value.
    pp,pn,pd,pw,_=joint.patch_observations(rgb,current,radius=3,patch_radius=4)
    if len(pw)>=12:
        increment=joint.fit_shared_field(pp,pn,pd,pw,original.shape,spacing=8)
        proposed,geometry=joint.bounded_field_update(total,increment,original,radius)
        if proposed is not None:
            candidate=joint.warp_alpha(original,proposed)
            audit,uncertain=source_contour_evidence(rgb,candidate>=128,np.zeros(original.shape,bool),material=True,alpha=candidate)
            if (audit['boundaryMatchRatio']>measurement['boundaryMatchRatio']
                    and audit['longestUnsupportedRun']<=measurement['longestUnsupportedRun']):
                current,total,measurement,unknown=candidate,proposed,audit,uncertain
                records.append(geometry)
    # The coarse raster is used only to estimate a fine coordinate field.
    # Compose and validate both fields, then sample the ORIGINAL alpha once.
    coarse_field=total
    _,fine,_,fine_records=refine_shared_source_field(
        rgb,current.copy(),np.zeros_like(total),joint,iterations,6)
    safe,composition=joint.bounded_field_update(coarse_field,fine,source_alpha,radius)
    if safe is None:
        return original.copy(),{'applied':False,'rejected':'unsafe_composed_geometry',
            'composition':composition},joint.invert_field(coarse_field)
    # Validate the actual one-sample raster, not the softer fitting raster.
    # Any subpixel correction also uses the full composed geometry limits.
    current,total,measurement,final_records=refine_shared_source_field(
        rgb,source_alpha,safe,joint,7,radius,start_iteration=6)
    return current,{'applied':True,'iterations':records,'fineIterations':fine_records,
        'finalIterations':final_records,'composition':composition,
        'alphaResamplingStages':1,'fittingEvidence':measurement},joint.invert_field(total)


def refine_shared_source_field(rgb, original, total, joint, iterations, radius, start_iteration=0):
    """Refine a fixed alpha frame; never sample an earlier iteration's raster."""
    current=joint.warp_alpha(original,total)
    measurement,unknown=source_contour_evidence(rgb,current>=128,np.zeros(original.shape,bool),material=True,alpha=current)
    records=[]
    def rank(audit):
        return (audit['boundaryMatchRatio']>=.9 and audit['longestUnsupportedRun']<=12,
                min(audit['boundaryMatchRatio'],.9),-audit['longestUnsupportedRun'],audit['boundaryMatchRatio'])
    best_state=(current,total,measurement,list(records))
    for iteration in range(iterations):
        if measurement['boundaryMatchRatio']>=.9 and measurement['longestUnsupportedRun']<=12:break
        visible=current>=128;boundary=visible&~nd.binary_erosion(visible)
        signed=nd.distance_transform_edt(visible)-nd.distance_transform_edt(~visible)
        gy,gx=np.gradient(nd.gaussian_filter(signed,1))
        ys,xs=np.nonzero(boundary)
        normals=np.column_stack((gx[ys,xs],gy[ys,xs]))
        normals/=np.maximum(np.linalg.norm(normals,axis=1)[:,None],.001)
        points=np.column_stack((xs,ys));distances=np.zeros(len(points))
        weights=np.where(unknown[ys,xs]>0,0.,2.)
        best=np.where(weights>0,0.,np.inf)
        shifts=[(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]
        if iteration+start_iteration>=6:shifts.extend([(-2,0),(2,0),(0,-2),(0,2)])
        for dx,dy in shifts:
            projection=normals@np.array([dx,dy])
            cost=dx*dx+dy*dy+.25*(dx*dx+dy*dy-projection**2)
            eligible=cost<best
            if not eligible.any():continue
            matrix=np.float32([[1,0,dx],[0,1,dy]])
            moved=cv2.warpAffine(current,matrix,(original.shape[1],original.shape[0]))
            query=np.zeros(original.shape,np.uint8);query[ys[eligible],xs[eligible]]=1
            query=cv2.warpAffine(query,matrix,(original.shape[1],original.shape[0]))>0
            _,uncertain=source_contour_evidence(rgb,moved>=128,np.zeros(original.shape,bool),material=True,alpha=moved,query=query)
            xx,yy=xs+dx,ys+dy
            inside=(xx>=0)&(yy>=0)&(xx<original.shape[1])&(yy<original.shape[0])
            ok=np.zeros(len(points),bool);ok[inside]=uncertain[yy[inside],xx[inside]]==0
            select=ok&eligible
            best[select]=cost[select];distances[select]=projection[select];weights[select]=1.
        increment=joint.fit_shared_field(points[weights>0],normals[weights>0],distances[weights>0],weights[weights>0],original.shape,spacing=6)
        proposed,geometry=joint.bounded_field_update(total,increment,original,radius)
        if proposed is None:break
        candidate=joint.warp_alpha(original,proposed)
        audit,uncertain=source_contour_evidence(rgb,candidate>=128,np.zeros(original.shape,bool),material=True,alpha=candidate)
        if audit['boundaryMatchRatio']<measurement['boundaryMatchRatio']-.01:break
        current,total,measurement,unknown=candidate,proposed,audit,uncertain
        records.append(geometry)
        if rank(measurement)>rank(best_state[2]):best_state=(current,total,measurement,list(records))
    current,total,measurement,records=best_state
    return current,total,measurement,records


def source_registered_assembly(source, matte, allowed, semantic_evidence):
    """Search source normals without treating a model's offset as ground truth.

    Global color clustering is unreliable for pale metal against a pale page.
    This separate proposal uses the source transition along a complete contour,
    then the same independent geometry, identity and semantic gates.
    """
    rgb = np.asarray(source.convert('RGB'))
    original = np.asarray(matte)
    proposal = original >= 128
    _, material, _ = semantic_evidence
    radius = max(16, min(48, round(min(matte.size)*.1)))
    alpha = register_source_contours(rgb, original, radius, proposal, source_search=True)
    alpha[material] = 255
    visible = alpha >= 128
    old_holes = nd.binary_fill_holes(proposal) & ~proposal
    new_holes = nd.binary_fill_holes(visible) & ~visible
    changed = np.count_nonzero(proposal != visible)
    if (np.any((alpha > 0) & ~allowed)
            or np.any((alpha > 0) & (nd.distance_transform_edt(~proposal) > radius))
            or nd.label(proposal)[1] != nd.label(visible)[1]
            or nd.label(old_holes)[1] != nd.label(new_holes)[1]
            or changed > proposal.sum()*.25):
        return None
    measurement, _ = source_contour_evidence(rgb, visible, np.zeros_like(visible), material=True, alpha=alpha)
    if measurement['boundaryMatchRatio'] < .9 or measurement['longestUnsupportedRun'] > 12:
        return None
    colors = rgb.copy()
    samples, _, _ = component_seeds(visible, nd.distance_transform_edt(visible), 1.5)
    nearest = nd.distance_transform_edt(~samples, return_distances=False, return_indices=True)
    soft = (alpha > 0) & (alpha < 255)
    colors[soft] = rgb[tuple(nearest)][soft]
    audit = {'status': 'passed', 'reviewReasons': [], **measurement,
             'minimumRatio': .9, 'maximumUnsupportedRun': 12, 'radiusPixels': radius,
             'changedPixels': int(changed), 'changedAreaRatio': round(float(changed/proposal.sum()), 6),
             'contourIntegrity': alpha_contour_integrity(visible, alpha),
             'localContourRepair': {'applied': bool(changed), 'changedPixels': int(changed),
                 'method': 'source_search_registration', 'maximumShiftPixels': radius}}
    return Image.fromarray(alpha), audit, Image.fromarray(colors)


def preserves_assembly_parts(proposal, visible, radius):
    """Track parts, not the possibly incorrect number of proposal fragments.

    Source-supported fragments may join. Each original part must still have a
    surviving core in one result component; newly invented islands and split
    cores are rejected. Independent source-edge and semantic checks still apply.
    """
    seeds, old_labels, _ = component_seeds(proposal, nd.distance_transform_edt(proposal), radius)
    new_labels, new_count = nd.label(visible)
    owners = set()
    for index, box in enumerate(nd.find_objects(old_labels), 1):
        selected = seeds[box] & (old_labels[box] == index)
        destinations = np.unique(new_labels[box][selected])
        destinations = destinations[destinations > 0]
        if len(destinations) != 1:
            return False
        owners.add(int(destinations[0]))
    return len(owners) == new_count


def source_assembly_matte(source, matte, allowed, semantic_evidence):
    """Re-estimate composite silhouettes from source, not an affine model mask.

    A thick proposed rim can put background inside an eroded hard-FG seed.
    Use a scale-bounded uncertain band and source-inspected material anchors.
    The model still limits identity; source segmentation cannot add a remote
    object, punch unsupported material holes or erase an existing part.
    Return only independently supported geometry; otherwise keep diagnostics.
    """
    rgb = np.asarray(source.convert('RGB'))
    proposal = np.asarray(matte) >= 128
    hole_labels, material, objects = semantic_evidence
    radius = max(16, min(48, round(min(matte.size)*.08)))
    inside = nd.distance_transform_edt(proposal)
    outside = nd.distance_transform_edt(~proposal)
    labels = np.where(proposal, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
    labels[(inside > radius) | material] = cv2.GC_FGD
    labels[(outside > radius) | ~allowed] = cv2.GC_BGD
    # Erosion at a junction is still not a semantic guarantee. If a proposed
    # core pixel is indistinguishable from observed exterior colors, make it
    # probabilistic rather than locking background inside the object forever.
    # This never labels an ambiguous material pixel as definite background.
    from scipy.spatial import cKDTree
    background_colors = np.unique(rgb[(outside > radius) & allowed], axis=0)
    if len(background_colors):
        if len(background_colors) > 4096:
            background_colors = background_colors[np.linspace(0, len(background_colors)-1, 4096).astype(int)]
        distance, _ = cKDTree(background_colors.astype(float)).query(rgb[proposal].astype(float))
        # Do not train the initial foreground GMM on those background-colored
        # pixels either: a widened rim otherwise creates its own BG-as-FG mode.
        values = labels[proposal]
        values[distance <= 3.] = cv2.GC_PR_BGD
        labels[proposal] = values
        labels[material] = cv2.GC_FGD
    counters = (hole_labels > 0) & ~material
    counter_seeds, _, _ = component_seeds(counters, nd.distance_transform_edt(counters), radius)
    labels[counter_seeds] = cv2.GC_BGD
    for item in objects:
        x, y = item['point']
        if not proposal[y, x] or not allowed[y, x]:
            return None
        labels[y, x] = cv2.GC_FGD
    if not np.any(labels == cv2.GC_BGD) or not np.any(labels == cv2.GC_FGD):
        return None
    known_background = labels == cv2.GC_BGD
    cv2.setNumThreads(1); cv2.setRNGSeed(0)
    cv2.grabCut(np.ascontiguousarray(rgb), labels, None, np.zeros((1,65)), np.zeros((1,65)), 5, cv2.GC_INIT_WITH_MASK)
    visible = (labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)
    # A reconnected ring encloses background that was exterior in the rough
    # proposal. Preserve its definite background seeds; filling it would undo
    # the source correction. Unseeded photometric holes in solid material are
    # still restored, and protected counter identities are checked by the caller.
    new_holes, _ = nd.label(nd.binary_fill_holes(visible) & ~visible)
    keep_holes = np.unique(new_holes[counters | known_background]); keep_holes = keep_holes[keep_holes > 0]
    visible |= (new_holes > 0) & ~np.isin(new_holes, keep_holes)
    if (np.any(visible & ~allowed) or np.any(visible & (outside > radius))
            or not preserves_assembly_parts(proposal, visible, radius)):
        return None
    measurement, _ = source_contour_evidence(rgb, visible, np.zeros_like(visible), material=True)
    if measurement['boundaryMatchRatio'] < .9 or measurement['longestUnsupportedRun'] > 12:
        return None
    # Recover subpixel coverage from actual source mixtures, without changing
    # the independently checked binary contour or opaque source interiors.
    inner, outer = nd.distance_transform_edt(visible), nd.distance_transform_edt(~visible)
    foreground, _, _ = component_seeds(visible, inner, 2.)
    background = (~visible) & (outer > 2.)
    if not foreground.any() or not background.any():
        return None
    fi = nd.distance_transform_edt(~foreground, return_distances=False, return_indices=True)
    bi = nd.distance_transform_edt(~background, return_distances=False, return_indices=True)
    f, b = rgb[tuple(fi)].astype(float), rgb[tuple(bi)].astype(float)
    delta = f-b; denominator = np.sum(delta*delta, axis=2)
    blend = np.clip(np.sum((rgb-b)*delta, axis=2)/np.maximum(denominator, 1), 0, 1)
    residual = np.max(np.abs(rgb-(b+blend[...,None]*delta)), axis=2)
    edge = (inner <= 1.5) & (outer <= 1.5) & (denominator >= 36) & (residual <= 2)
    alpha = visible.astype(np.uint8)*255
    coverage = np.rint(blend*255).astype(np.uint8)
    edge &= (coverage >= 128) == visible
    alpha[edge] = coverage[edge]
    alpha[material] = 255
    colors = rgb.copy(); soft = (alpha > 0) & (alpha < 255)
    colors[soft] = np.rint(f[soft]).astype(np.uint8)
    changed = int(np.count_nonzero(visible != proposal))
    audit = {'status':'passed', 'reviewReasons':[], 'radiusPixels':radius,
             'changedPixels':changed, 'changedAreaRatio':round(changed/max(1,proposal.sum()),6),
             **measurement, 'minimumRatio':.9, 'maximumUnsupportedRun':12,
             'contourIntegrity':alpha_contour_integrity(visible,alpha),
             'localContourRepair':{'applied':bool(changed), 'method':'source_assembly_segmentation',
                                   'changedPixels':changed, 'maximumShiftPixels':radius}}
    return Image.fromarray(alpha), audit, Image.fromarray(colors)


def fit_color_plane(rgb, samples):
    """Robust affine source-color fit; reject insufficient or non-planar data."""
    yy, xx = np.indices(samples.shape)
    basis = np.stack((np.ones_like(xx), xx / max(1, xx.max()), yy / max(1, yy.max())), axis=2)
    x, colors = basis[samples], rgb[samples].astype(float)
    if len(x) < 12 or np.linalg.matrix_rank(x) < 3:
        return None
    keep = np.ones(len(x), dtype=bool)
    for _ in range(4):
        coefficients = np.linalg.lstsq(x[keep], colors[keep], rcond=None)[0]
        residual = np.max(np.abs(x @ coefficients - colors), axis=1)
        keep = residual <= max(1, np.percentile(residual, 75))
    if np.percentile(residual, 75) > 3:
        return None
    return np.clip(basis @ coefficients, 0, 255)


def local_plane_matte(rgb, component, seeds, background, radius):
    """Recover local glyph alpha and holes when two smooth color fields explain it."""
    f = fit_color_plane(rgb, seeds & component)
    b = fit_color_plane(rgb, background)
    if f is None or b is None:
        return None
    delta = f - b
    denominator = np.sum(delta * delta, axis=2)
    mixture = np.sum((rgb.astype(float)-b) * delta, axis=2) / np.maximum(denominator, 1)
    blend = np.clip(mixture, 0, 1)
    residual = np.max(np.abs(rgb-(b+blend[..., None]*delta)), axis=2)
    band = nd.distance_transform_edt(~component) <= radius
    evidence = (denominator >= 6**2) & (residual <= np.maximum(2, np.sqrt(denominator)*.06))
    # The whole proposed glyph, not just its outer contour, must fit the source.
    if np.mean(evidence[component]) < .98:
        return None
    blend[~band] = 0
    visible = blend >= .5
    # A good color fit alone cannot distinguish a material's gray shading from
    # transparency. Only recover partial alpha near a contour, not deep inside
    # an otherwise opaque component; defer ambiguous interiors to the trimap.
    interior = nd.distance_transform_edt(visible) > radius
    # Account for quantization/model residual in both estimated color fields:
    # a few RGB levels matter much more at low contrast than at high contrast.
    alpha_tolerance = np.minimum(.25, 4 / np.maximum(np.sqrt(denominator), 1))
    if np.any(interior & (blend > alpha_tolerance) & (blend < 1 - alpha_tolerance)):
        return None
    boundary = visible & ~nd.binary_erosion(visible)
    if not boundary.any() or np.mean(evidence[boundary]) < .98:
        return None
    # Do not let model extrapolation at an ROI edge add or remove a whole glyph.
    if np.mean(visible[seeds & component]) < .7:
        return None
    return np.rint(blend*255).astype(np.uint8), evidence, f


def contour_step_evidence(rgb, visible, boundary, noise):
    """Separate a source color step from repeated texture crossing a contour.

    Sample along the contour normal, stopping before a thin stroke's opposite
    edge. A real edge has a coherent color transition; periodic noise may have
    a strong nearby gradient but reverses direction across the same profile.
    This is geometric evidence, not semantic completeness or ground-truth IoU.
    """
    signed = (nd.distance_transform_edt(visible) - nd.distance_transform_edt(~visible)).astype(np.float32)
    gy, gx = np.gradient(nd.gaussian_filter(signed, 1))
    y, x = np.nonzero(boundary)
    length = np.hypot(gx[y, x], gy[y, x])
    nx, ny = gx[y, x] / np.maximum(length, .001), gy[y, x] / np.maximum(length, .001)
    offsets = np.arange(-3, 4)
    xs, ys = x[None, :] + offsets[:, None]*nx, y[None, :] + offsets[:, None]*ny
    samples = np.stack([nd.map_coordinates(rgb[..., c].astype(float), [ys, xs], order=1, mode="nearest")
                        for c in range(3)], axis=2)
    membership = nd.map_coordinates(visible.astype(np.uint8), [ys, xs], order=0, mode="nearest")
    first, last = np.full(len(x), 3), np.full(len(x), 3)
    for step in range(1, 4):
        first = np.where((first == 4-step) & ~membership[3-step].astype(bool), 3-step, first)
        last = np.where((last == 2+step) & membership[3+step].astype(bool), 3+step, last)
    columns = np.arange(len(x))
    delta = np.abs(samples[last, columns] - samples[first, columns])
    channel = np.argmax(delta, axis=1)
    contrast = delta[columns, channel]
    differences = np.abs(np.diff(samples, axis=0))[:, columns, channel]
    included = (np.arange(6)[:, None] >= first) & (np.arange(6)[:, None] < last)
    variation = (differences * included).sum(axis=0)
    supported = (length > .1) & (contrast >= np.maximum(6, noise[y, x]*3))
    supported &= contrast / np.maximum(variation, 1) >= .65
    result = np.zeros_like(visible)
    result[y, x] = supported
    return result


def soft_transition_evidence(rgb, visible, boundary):
    """Locate a source transition independently of its sharpness.

    Fit two slowly varying colors separated by a blurred step along the normal.
    The transition itself is not a noise estimate. Search displaced centers too:
    a good fit to a nearby edge must not certify a misregistered contour.
    This supplies evidence only; it never changes alpha or fills an unknown arc.
    """
    signed = (nd.distance_transform_edt(visible) - nd.distance_transform_edt(~visible)).astype(np.float32)
    gy, gx = np.gradient(nd.gaussian_filter(signed, 1))
    y, x = np.nonzero(boundary)
    result = np.zeros_like(visible)
    if not len(x):
        return result
    # Bound profile-fit temporaries even for a dense, multi-component matte.
    values = rgb.astype(float)
    for start in range(0, len(x), 2048):
        ys, xs = y[start:start+2048], x[start:start+2048]
        result[ys, xs] = _soft_profile_batch(values, visible, ys, xs, gy, gx)
    return result


def _soft_profile_batch(rgb, visible, y, x, gy, gx):
    length = np.hypot(gx[y, x], gy[y, x])
    nx, ny = gx[y, x]/np.maximum(length, .001), gy[y, x]/np.maximum(length, .001)
    offsets = np.arange(-8, 8.01, .5)
    xs, ys = x[None, :] + offsets[:, None]*nx, y[None, :] + offsets[:, None]*ny
    samples = np.stack([nd.map_coordinates(rgb[..., c], [ys, xs], order=1, mode="nearest")
                        for c in range(3)], axis=2)
    membership = nd.map_coordinates(visible.astype(np.uint8), [ys, xs], order=0, mode="nearest")
    # Avoid another stroke, counter or image border inside the fitted profile.
    valid = ((length > .1) & np.all(membership[offsets <= -1.5] == 0, axis=0)
             & np.all(membership[offsets >= 1.5] == 1, axis=0)
             & np.all((xs >= 0) & (xs <= rgb.shape[1]-1) & (ys >= 0) & (ys <= rgb.shape[0]-1), axis=0))
    linear = np.column_stack((np.ones_like(offsets), offsets))
    flat = samples.reshape(len(offsets), -1)
    baseline = linear @ (np.linalg.pinv(linear) @ flat)
    baseline_error = np.mean((flat-baseline).reshape(samples.shape)**2, axis=(0, 2))
    # A flexible color fit can explain one bend of a periodic texture by
    # extrapolating implausible F/B colors. Require an observed, coherent step
    # over the complete profile as well, not merely a low fitting residual.
    observed_contrast = np.linalg.norm(samples[-1]-samples[0], axis=1)
    variation = np.linalg.norm(np.diff(samples, axis=0), axis=2).sum(axis=0)
    coherent = observed_contrast / np.maximum(variation, 1) >= .65
    best_error = np.full(len(x), np.inf)
    best_center = np.zeros(len(x))
    best_contrast = np.zeros(len(x))
    for sigma in (.5, 1., 1.5, 2., 2.5, 3.):
        for center in np.arange(-3.5, 3.01, .5):
            transition = ndtr((offsets-center)/sigma)
            basis = np.column_stack((linear, transition, offsets*transition))
            coefficients = np.linalg.pinv(basis) @ flat
            error = np.mean((flat-basis@coefficients).reshape(samples.shape)**2, axis=(0, 2))
            contrast = np.linalg.norm((coefficients[2]+center*coefficients[3]).reshape(-1,3), axis=1)
            better = error < best_error
            best_error[better] = error[better]
            best_center[better] = center
            best_contrast[better] = contrast[better]
    # Boundary pixel centers lie up to one pixel inside the raster silhouette.
    # The source transition must be within one source pixel of that contour.
    supported = (valid & coherent & (best_center >= -1.5) & (best_center <= .5)
                 & (best_contrast >= 12) & (best_error <= np.maximum(2., best_contrast*.04)**2)
                 & (best_error <= baseline_error*.25))
    return supported


def chromatic_contour_evidence(rgb, visible, boundary):
    """Measure color steps separately from common-mode reflected light.

    A large luminance gradient must not mask a smaller, aligned color edge.
    The same local contrast, one-pixel tolerance and coherent-step checks still
    apply. This is source evidence, not a license to interpolate unknown arcs.
    """
    values = rgb.astype(np.float32)
    values -= values.mean(axis=2, keepdims=True)
    strength = np.zeros_like(visible, dtype=np.float32)
    for dy, dx in ((0, 1), (1, 0)):
        contrast = np.max(np.abs(values[:-dy or None, :-dx or None] - values[dy:, dx:]), axis=2)
        strength[:-dy or None, :-dx or None] = np.maximum(strength[:-dy or None, :-dx or None], contrast)
        strength[dy:, dx:] = np.maximum(strength[dy:, dx:], contrast)
    noise = nd.percentile_filter(strength, percentile=25, size=7)
    peak = nd.maximum_filter(strength, size=5)
    edges = (strength >= np.maximum(3, noise*2)) & (strength >= peak*.5)
    edges = nd.binary_dilation(edges, iterations=1)
    return edges & contour_step_evidence(values, visible, boundary, noise)


def patch_contour_evidence(rgb, visible, boundary):
    """Verify soft corners with a 2-D source fit, not a single crossing normal.

    Fit one color step plus a shared illumination plane. Competing displaced
    silhouettes must fit worse; a smooth plane or texture is not evidence.
    The fit is diagnostic only and cannot invent or change the contour.
    """
    result = np.zeros_like(visible)
    ys, xs = np.nonzero(boundary)
    if not len(xs):
        return result
    # Bound diagnostic work on adversarial/dense contours. Unchecked pixels
    # remain unsupported; this limit never turns a failure into a pass.
    if len(xs) > 2048:
        selected = np.linspace(0,len(xs)-1,2048).astype(int)
        ys,xs = ys[selected],xs[selected]
    radius = 6
    py, px = np.mgrid[-radius:radius+1, -radius:radius+1]
    plane = np.column_stack((np.ones(px.size), px.ravel()/radius, py.ravel()/radius))
    inverse_plane = np.linalg.pinv(plane)
    blurred = [nd.gaussian_filter(visible.astype(float), sigma) for sigma in (.5, 1., 1.5, 2., 2.5, 3.)]
    # Closest displacement first so an unidentifiable tangent shift cannot
    # falsely reject a straight edge with an equally good zero-offset fit.
    shifts = sorted(((dy, dx) for dy in range(-3,4) for dx in range(-3,4)), key=lambda p: p[0]**2+p[1]**2)
    for y, x in zip(ys, xs):
        if min(x,y) < radius+3 or x+radius+3 >= visible.shape[1] or y+radius+3 >= visible.shape[0]:
            continue
        samples = rgb[y-radius:y+radius+1, x-radius:x+radius+1].reshape(-1,3).astype(float)
        baseline = np.mean((samples-plane@(inverse_plane@samples))**2)
        best_error, best_shift, best_contrast = np.inf, (0,0), 0.
        for shape in blurred:
            for dy, dx in shifts:
                coverage = shape[y-radius+dy:y+radius+1+dy, x-radius+dx:x+radius+1+dx].ravel()
                basis = np.column_stack((plane,coverage))
                coefficients = np.linalg.lstsq(basis,samples,rcond=None)[0]
                error = np.mean((samples-basis@coefficients)**2)
                if error < best_error-1e-7:
                    best_error, best_shift = error, (dy,dx)
                    best_contrast = np.linalg.norm(coefficients[-1])
        result[y,x] = (sum(d*d for d in best_shift) <= 2 and best_contrast >= 12
                       and best_error <= max(3.,best_contrast*.1)**2 and best_error < baseline*.35)
    return result


def align_uncertain_segments(alpha, observed, uncertain, radius=4):
    """Repair bounded line registration without tracing photographic noise.

    Fit a low-order normal displacement to the whole existing straight edge,
    not just the noisy failed pixels. Curves and unsupported distant observations
    remain untouched. The caller must independently verify the resulting alpha.
    """
    visible = alpha >= 128
    current = nd.distance_transform_edt(visible)-nd.distance_transform_edt(~visible)
    target = nd.distance_transform_edt(observed)-nd.distance_transform_edt(~observed)
    gy, gx = np.gradient(nd.gaussian_filter(current,1))
    mapdx, mapdy = np.zeros_like(current), np.zeros_like(current)
    points = np.column_stack(np.nonzero(uncertain)[::-1])
    if not len(points):
        return alpha.copy()
    for contour in cv2.findContours(visible.astype(np.uint8),cv2.RETR_LIST,cv2.CHAIN_APPROX_NONE)[0]:
        poly = cv2.approxPolyDP(contour,1.,True)[:,0,:].astype(float)
        for p0,p1 in zip(poly,np.roll(poly,-1,axis=0)):
            length = np.linalg.norm(p1-p0)
            if length < 20:
                continue
            tangent = (p1-p0)/length
            normal = np.array([-tangent[1],tangent[0]])
            at, distance = (points-p0)@tangent, np.abs((points-p0)@normal)
            if not np.any((at>2)&(at<length-2)&(distance<2)):
                continue
            t = np.arange(2,length-1)
            sample = p0+t[:,None]*tangent
            displacement = nd.map_coordinates(target-current,[sample[:,1],sample[:,0]],order=1)
            # Reject a different object/large registration error, rather than
            # clipping its displacement and pretending it is a local repair.
            if np.mean(np.abs(displacement) <= radius) < .9:
                continue
            basis = np.column_stack((np.ones(len(t)),t/length))
            fitted = least_squares(lambda c: basis@c-displacement, [0.,0.],loss='soft_l1',f_scale=.5).x
            if np.max(np.abs(basis@fitted)) > radius:
                continue
            direction = (nd.map_coordinates(gx,[sample[:,1],sample[:,0]],order=1)*normal[0]
                         + nd.map_coordinates(gy,[sample[:,1],sample[:,0]],order=1)*normal[1])
            sign = np.sign(np.median(direction))
            x0,y0 = np.maximum(0,np.floor(np.minimum(p0,p1)-6)).astype(int)
            x1,y1 = np.minimum([alpha.shape[1],alpha.shape[0]],np.ceil(np.maximum(p0,p1)+7)).astype(int)
            yy,xx = np.mgrid[y0:y1,x0:x1]
            qx,qy = xx-p0[0],yy-p0[1]
            at = qx*tangent[0]+qy*tangent[1]
            distance = np.abs(qx*normal[0]+qy*normal[1])
            influence = np.clip(1-distance/5,0,1)*np.clip(at/4,0,1)*np.clip((length-at)/4,0,1)
            delta = (fitted[0]+fitted[1]*at/length)*influence*sign
            mapdx[y0:y1,x0:x1] += delta*normal[0]
            mapdy[y0:y1,x0:x1] += delta*normal[1]
    if np.max(np.hypot(mapdx,mapdy)) > radius:
        return alpha.copy()
    yy,xx = np.indices(alpha.shape)
    return cv2.remap(alpha,(xx+mapdx).astype(np.float32),(yy+mapdy).astype(np.float32),cv2.INTER_LINEAR)


def material_profile_support(rgb, positions, normals):
    """Verify the *first* material departure from a locally smooth background.

    Metal rims may go dark/light/dark inside an opaque object. A monotone-step
    test rejects these real edges. Fit background only outside, require that it
    still explains the exterior next to the edge, and require a persistent
    source departure at the edge. Nearby internal highlights cannot supply it.
    """
    offsets = np.array([-6., -5., -4., -3., -2., -1.5, 0., .5, 1., 2., 3., 4., 5.])
    samples = []
    in_bounds = np.ones(positions.shape[:-1], bool)
    for offset in offsets:
        at = positions+offset*normals
        in_bounds &= ((at[..., 0] >= 0)&(at[..., 0] < rgb.shape[1]-1)
                      &(at[..., 1] >= 0)&(at[..., 1] < rgb.shape[0]-1))
        samples.append(np.stack([nd.map_coordinates(rgb[..., c].astype(float),
            [at[..., 1], at[..., 0]], order=1, mode='nearest') for c in range(3)], axis=-1))
    samples = np.asarray(samples)
    background = samples[:5].mean(axis=0)
    weights = (offsets[:5]+4).reshape((5,)+(1,)*(samples.ndim-1))
    slope = (weights*samples[:5]).sum(axis=0)/10
    predicted = background[None]+(offsets+4).reshape((-1,)+(1,)*(samples.ndim-1))*slope[None]
    residual = np.max(np.abs(samples-predicted), axis=-1)
    noise = residual[:5].max(axis=0)
    threshold = np.maximum(6., noise*3+1)
    stable_outside = (noise <= 2.5)&(residual[5] <= np.maximum(3., noise*2+1))
    onset = np.count_nonzero(residual[6:9] >= threshold, axis=0) >= 2
    persistent = np.count_nonzero(residual[8:13] >= threshold, axis=0) >= 3
    # A cast shadow is also a first departure from smooth background. It must
    # not pull the contour away from a stronger, observed opaque edge. Reserve
    # this extra evidence for reflective/chromatic material: at least one
    # channel rises above the exterior prediction near the rim. Ordinary dark
    # object edges remain covered by the step/chromatic tests, without this
    # special override of the source-segmentation prior.
    material_rise = np.max(samples[6:11]-predicted[6:11], axis=(0, -1)) >= threshold
    return in_bounds & stable_outside & onset & persistent & material_rise


def material_boundary_evidence(rgb, visible, boundary):
    signed = nd.distance_transform_edt(visible)-nd.distance_transform_edt(~visible)
    gy, gx = np.gradient(nd.gaussian_filter(signed, 1))
    y, x = np.nonzero(boundary)
    length = np.hypot(gx[y, x], gy[y, x])
    normal = np.column_stack((gx[y, x], gy[y, x]))/np.maximum(length[:, None], .001)
    result = np.zeros_like(visible)
    result[y, x] = material_profile_support(rgb, np.column_stack((x, y)).astype(float), normal)
    return result


def coverage_boundary_evidence(rgb, alpha, boundary):
    """Verify a textured rim against its observed, coverage-aware exterior.

    Binary-normal profiles assume a fully transparent sample within two pixels
    and monotone foreground colors. Neither holds at soft metallic corners or
    narrow gaps. Fit only source samples beyond the actual alpha tail, then
    require *all* transparent samples (including held-out near-edge samples) to
    agree with that background and an immediate material departure at the rim.
    A displaced/shrunken matte contaminates those held-out exterior samples;
    an expanded matte has no departure. This never changes coverage or RGB.
    """
    alpha = np.asarray(alpha)
    coverage = alpha.astype(float)/255
    distance = nd.distance_transform_edt(alpha < 8)
    result = np.zeros(alpha.shape, bool)
    for radius, degree in ((4, 1), (6, 1), (12, 1), (4, 2), (6, 2), (12, 2)):
        py, px = np.mgrid[-radius:radius+1, -radius:radius+1]
        plane = np.column_stack((np.ones(px.size), px.ravel()/radius, py.ravel()/radius))
        if degree == 2:
            plane = np.column_stack((plane, (px.ravel()/radius)**2,
                                     px.ravel()*py.ravel()/radius**2, (py.ravel()/radius)**2))
        near = px.ravel()**2+py.ravel()**2 <= 4
        ys, xs = np.nonzero(boundary & ~result)
        for y, x in zip(ys, xs):
            if min(x, y) < radius or x+radius >= alpha.shape[1] or y+radius >= alpha.shape[0]:
                continue
            box = np.s_[y-radius:y+radius+1, x-radius:x+radius+1]
            a = coverage[box].ravel()
            colors = rgb[box].reshape(-1, 3).astype(float)
            exterior = (distance[box].ravel() > 1.5) & (a < .03)
            if exterior.sum() < max(10, 3*plane.shape[1]) or np.linalg.matrix_rank(plane[exterior]) < plane.shape[1]:
                continue
            coefficients = np.linalg.lstsq(plane[exterior], colors[exterior], rcond=None)[0]
            predicted = plane@coefficients
            difference = colors-predicted
            residual = np.max(np.abs(difference), axis=1)
            noise = np.percentile(residual[exterior], 95)
            outer, inner = a < .03, (a >= .5) & near
            if noise > 2.5 or outer.sum() < 2 or inner.sum() < 2:
                continue
            # Low coverage is not zero coverage. The compositing equation
            # bounds its possible RGB departure without knowing material RGB:
            # I-B = alpha*(F-B), with every channel of F in [0, 255].
            # A truly transparent pixel gets only fit/quantization tolerance.
            tolerance = (a[:, None]*np.maximum(np.abs(predicted), np.abs(255-predicted))
                         + max(1, 2*noise+1))
            stable = np.all(np.abs(difference[outer]) <= tolerance[outer])
            threshold = max(6, 3*noise+1)
            departed = np.count_nonzero(residual[inner] >= threshold) >= 2
            # Common-mode darkening alone may be a cast shadow, not material.
            rim = difference[inner]
            material = (rim.max() >= threshold
                        or np.max(np.abs(rim-rim.mean(axis=1, keepdims=True))) >= threshold)
            result[y, x] = (stable and departed and material
                            and residual[px.size//2] >= max(4, 2*noise+1))
    return result


def unmodeled_source_counters(rgb, alpha, semantic_evidence):
    """An outer-edge match cannot certify an interior hole that is filled in.

    Check for sizeable, observed-exterior-colored regions hidden under opaque
    coverage. Color alone cannot decide whether these are actual background or
    identically colored material: retain alpha, but do not certify completeness.
    Explicit source-inspected material regions/anchors resolve that ambiguity.
    """
    visible = np.asarray(alpha) >= 128
    background = fit_color_plane(rgb, nd.distance_transform_edt(~visible) > 3)
    if background is None:
        return 0
    matching = (np.max(np.abs(rgb.astype(float)-background), axis=2) <= 3) & visible
    labels, _ = nd.label(matching)
    interior = nd.distance_transform_edt(visible) > 2
    _, material, objects = semantic_evidence
    protected = set(np.unique(labels[material]))
    protected.update(int(labels[item['point'][1], item['point'][0]]) for item in objects)
    return sum(1 for index, box in enumerate(nd.find_objects(labels), 1)
               if index not in protected
               and np.count_nonzero((labels[box] == index) & interior[box]) >= 16)


def source_contour_evidence(rgb, visible, fitted_evidence, material=False, alpha=None, query=None):
    boundary = visible & ~nd.binary_erosion(visible)
    # Local registration queries only the moved, unresolved samples. This is
    # not a full quality audit: its denominator counts the queried boundary
    # only. Final delivery calls omit query and always inspect the whole mask.
    if query is not None:
        if np.asarray(query).shape != visible.shape:
            raise ValueError('MATTE_EVIDENCE_QUERY_MISMATCH')
        boundary &= np.asarray(query,dtype=bool)
    strength = np.zeros_like(visible, dtype=np.float32)
    values = rgb.astype(np.int16)
    for dy,dx in ((0,1),(1,0)):
        contrast = np.max(np.abs(values[:-dy or None,:-dx or None]-values[dy:,dx:]),axis=2)
        strength[:-dy or None,:-dx or None] = np.maximum(strength[:-dy or None,:-dx or None],contrast)
        strength[dy:,dx:] = np.maximum(strength[dy:,dx:],contrast)
    noise = nd.percentile_filter(strength,percentile=25,size=7)
    peak = nd.maximum_filter(strength,size=5)
    edges = nd.binary_dilation((strength>=np.maximum(3,noise*2))&(strength>=peak*.5),iterations=1)
    edges &= contour_step_evidence(rgb,visible,boundary,noise)
    soft = soft_transition_evidence(rgb,visible,boundary&~edges)
    edges |= soft | fitted_evidence
    chromatic = chromatic_contour_evidence(rgb,visible,boundary&~edges)
    edges |= chromatic
    material_pixels = material_boundary_evidence(rgb, visible, boundary&~edges) if material else np.zeros_like(visible)
    edges |= material_pixels
    coverage_pixels = np.zeros_like(visible)
    if material and alpha is not None:
        if np.asarray(alpha).shape != visible.shape or not np.array_equal(np.asarray(alpha) >= 128, visible):
            raise ValueError('MATTE_EVIDENCE_ALPHA_MISMATCH')
        coverage_pixels = coverage_boundary_evidence(rgb, alpha, boundary & ~edges)
        edges |= coverage_pixels
    unsupported,groups = nd.label(boundary&~edges,structure=np.ones((3,3)))
    longest = int(np.bincount(unsupported.ravel())[1:].max()) if groups else 0
    patch = np.zeros_like(visible)
    # Correct, previously delivered contours are byte-stable. Spend the more
    # expensive corner-fit only when the cheap checks cannot establish delivery.
    if longest > 12 or (boundary&edges).sum()/max(1,boundary.sum()) < .9:
        patch = patch_contour_evidence(rgb,visible,boundary&~edges)
        edges |= patch
        unsupported,groups = nd.label(boundary&~edges,structure=np.ones((3,3)))
    sizes = np.bincount(unsupported.ravel())
    longest = int(sizes[1:].max()) if groups else 0
    regions = []
    for index,box in enumerate(nd.find_objects(unsupported),1):
        if box is not None:
            ys,xs = box
            regions.append({'x':xs.start,'y':ys.start,'width':xs.stop-xs.start,'height':ys.stop-ys.start,'boundaryPixels':int(sizes[index])})
    regions.sort(key=lambda r:r['boundaryPixels'],reverse=True)
    count,matched = int(boundary.sum()),int((boundary&edges).sum())
    if not count or not np.any(strength>=3):
        fail('no distinct foreground/background contour evidence')
    return {'boundaryMatchRatio':round(matched/max(1,count),6),'boundaryPixels':count,'matchedBoundaryPixels':matched,
            'softTransitionBoundaryPixels':int((boundary&soft).sum()),'chromaticBoundaryPixels':int((boundary&chromatic).sum()),
            'materialBoundaryPixels':int((boundary&material_pixels).sum()),
            'coverageBoundaryPixels':int((boundary&coverage_pixels).sum()),
            'patchBoundaryPixels':int((boundary&patch).sum()),'longestUnsupportedRun':longest,'uncertainRegions':regions[:5]}, unsupported


def align_component_shape(proposal, observed, radius, align_counters=True):
    """Fit source displacement, not source texture, to the semantic contour.

    A robust, bounded affine fit uses the exterior contour only. Interior
    counters initially follow that transform; reliable counter evidence may
    align them independently. A collapsed hole can neither pull the fit inward
    nor be replaced by a single protected pixel. This is not a
    license to move content: final source-edge validation remains authoritative.
    """
    original = np.asarray(proposal, dtype=np.float32) / 255
    visible = original >= .5
    exterior = nd.binary_fill_holes(visible)
    target = nd.binary_fill_holes(observed)
    boundary = exterior & ~nd.binary_erosion(exterior)
    yy, xx = np.nonzero(boundary)
    if len(xx) < 6 or not target.any():
        return original
    center = np.array([xx.mean(), yy.mean()])
    scale = max(1., float(np.ptp(xx)), float(np.ptp(yy)))
    points = np.column_stack((xx, yy)).astype(float)
    basis = (points-center) / scale
    signed = nd.distance_transform_edt(target)-nd.distance_transform_edt(~target)
    signed -= np.sign(signed)*.5
    # Six displacement coefficients in pixels. Bounded corner displacement is
    # checked below as well; parameter bounds alone don't bound an affine fit.
    def moved(parameters):
        return points + parameters[:2] + basis @ parameters[2:].reshape(2,2)
    def residual(parameters):
        p = moved(parameters)
        # Boundary pixels are foreground pixel CENTERS, half a pixel inside
        # the contour. Fitting them to zero would expand even an exact mask.
        return nd.map_coordinates(signed, [p[:,1],p[:,0]], order=1, mode="nearest") - .5
    fitted = least_squares(residual, np.zeros(6), bounds=(-radius,radius),
                           loss="soft_l1", f_scale=1., diff_step=.01, max_nfev=60)
    displacement = moved(fitted.x)-points
    if np.max(np.linalg.norm(displacement,axis=1)) > radius:
        return original
    linear = np.eye(2)+fitted.x[2:].reshape(2,2).T/scale
    if np.linalg.det(linear) <= 0:
        return original
    matrix = np.column_stack((linear, center+fitted.x[:2]-linear@center)).astype(np.float32)
    warped = cv2.warpAffine(original, matrix, (original.shape[1],original.shape[0]),
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    if align_counters:
        # Outer and inner contours can have different model registration error.
        # Match existing counters only, never invent a hole from material shading.
        visible_warped = warped >= .5
        holes, hole_count = nd.label(nd.binary_fill_holes(visible_warped) & ~visible_warped)
        targets, _ = nd.label(target & ~observed)
        for index in range(1,hole_count+1):
            hole = holes == index
            overlap = np.bincount(targets[hole])
            if len(overlap) < 2 or not np.any(overlap[1:]):
                continue
            target_hole = targets == int(np.argmax(overlap[1:])+1)
            # GrabCut's single BG seed is not a measured counter boundary.
            if not .5 <= target_hole.sum()/hole.sum() <= 2:
                continue
            collar = nd.distance_transform_edt(~hole) <= 1.5
            counter_alpha = np.where(collar,1-warped,0)
            aligned_counter = align_component_shape(counter_alpha*255,target_hole,radius,False)
            # Restore the old hole before cutting the aligned one. The exterior
            # remains untouched; the topology check below rejects merged holes.
            warped = np.clip(warped+counter_alpha,0,1)*(1-aligned_counter)
    # Small counters/strokes must also survive rasterization of the transform.
    transformed = warped >= .5
    if (nd.label(transformed)[1] != nd.label(visible)[1]
            or nd.label(nd.binary_fill_holes(transformed) & ~transformed)[1]
            != nd.label(exterior & ~visible)[1]):
        return original
    return warped


def register_source_contours(rgb, alpha, radius, observed, source_search=False, return_observations=False):
    """Locate a smooth contour in the original image, inside the proposal band.

    A single affine transform cannot align independently displaced sides of a
    generated shape. Solve normal offsets jointly instead. This is a proposal
    for the existing independent evidence/topology gates, never a certificate.
    """
    visible = alpha >= 128
    signed = nd.distance_transform_edt(visible)-nd.distance_transform_edt(~visible)
    gy, gx = np.gradient(nd.gaussian_filter(signed, 1))
    observed_distance = nd.distance_transform_edt(observed)-nd.distance_transform_edt(~observed)
    observed_distance -= np.sign(observed_distance)*.5
    # The normal locations are foreground pixel centers, as in the evidence
    # tests. Half-pixel search centers can rasterize to the *next* pixel and
    # certify a different edge than the one delivered. Antialias coverage is
    # still integrated below at 4x, rather than thresholded from this grid.
    offsets = np.arange(-radius, radius+.01, 1.)
    rgb = rgb.astype(float)
    contours, hierarchy = cv2.findContours(visible.astype(np.uint8), cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return alpha.copy()
    scale = 4
    raster = np.zeros((alpha.shape[0]*scale, alpha.shape[1]*scale), np.uint8)
    observations = []
    for index, contour in enumerate(contours):
        points = contour[:, 0].astype(float)
        # Arc-length sampling prevents long straight edges from dominating
        # runtime; small counters keep their complete contour.
        stride = max(1, min(3, len(points)//24))
        points = points[::stride]
        x, y = points[:, 0].astype(int), points[:, 1].astype(int)
        length = np.hypot(gx[y, x], gy[y, x])
        normal = np.column_stack((gx[y, x], gy[y, x]))/np.maximum(length[:, None], .001)
        centers = points[:, None, :]+offsets[None, :, None]*normal[:, None, :]
        profile = []
        for distance in (-2., -1., 0., 1., 2.):
            positions = centers+distance*normal[:, None, :]
            profile.append(np.stack([nd.map_coordinates(rgb[..., c],
                [positions[..., 1], positions[..., 0]], order=1, mode='nearest') for c in range(3)], axis=-1))
        profile = np.asarray(profile)
        contrast = np.linalg.norm(profile[-1]-profile[0], axis=-1)
        variation = np.linalg.norm(np.diff(profile, axis=0), axis=-1).sum(axis=0)
        coherence = contrast/np.maximum(variation, 1)
        # Prefer a coherent source transition, not a nearby texture peak.
        score = contrast*coherence**2
        score /= np.maximum(score.max(axis=1, keepdims=True), 12)
        if return_observations:
            # A narrow ring has two nearby edges. Independently picking the
            # strongest gradient on each side changes its width or makes both
            # sides converge on an internal reflection. Score a shared normal
            # displacement against BOTH sides before fitting one smooth field.
            width = np.zeros(len(points))
            alive = np.ones(len(points), bool)
            for distance in np.arange(.5, 20, .5):
                at = points+distance*normal
                alive &= nd.map_coordinates(visible.astype(float),
                    [at[:,1],at[:,0]],order=0)>0
                width[alive] = distance
            thin = width < 10
            opposite = centers+width[:,None,None]*normal[:,None,:]
            other = []
            for distance in (-2.,-1.,0.,1.,2.):
                at = opposite-distance*normal[:,None,:]
                other.append(np.stack([nd.map_coordinates(rgb[...,c],
                    [at[...,1],at[...,0]],order=1,mode='nearest') for c in range(3)],axis=-1))
            other = np.asarray(other)
            contrast2 = np.linalg.norm(other[-1]-other[0],axis=-1)
            variation2 = np.linalg.norm(np.diff(other,axis=0),axis=-1).sum(axis=0)
            score2 = contrast2*(contrast2/np.maximum(variation2,1))**2
            score2 /= np.maximum(score2.max(axis=1,keepdims=True),12)
            score[thin] = (score[thin]+score2[thin])/2
        material = material_profile_support(rgb, centers, np.broadcast_to(normal[:, None, :], centers.shape))
        observed_residual = nd.map_coordinates(observed_distance, [centers[..., 1], centers[..., 0]], order=1, mode='nearest')-.5
        # GrabCut is a color observation, not ground truth: a dark metal lip
        # may be grouped with background while its bright inlay is foreground.
        # Bound that prior's influence so a measured *outer* material onset can
        # win; never expand the spatial band or waive the independent audit.
        observed_weight = .02 if source_search else .2
        displacement_weight = .001 if source_search else .015
        observed_cost = observed_weight*np.minimum(observed_residual**2, 9.)
        material_weight = .25 if return_observations else 2
        costs = 1-score-material_weight*material+displacement_weight*(offsets[None, :]+.5)**2+observed_cost
        smooth = .35*(offsets[:, None]-offsets[None, :])**2
        # Repeat the cycle and keep the middle revolution to remove a seam at
        # the arbitrarily selected start of a closed contour.
        repeated = np.tile(costs, (3, 1))
        values = repeated[0].copy()
        parents = np.zeros((len(repeated), len(offsets)), np.int16)
        for row in range(1, len(repeated)):
            transition = values[:, None]+smooth
            parents[row] = np.argmin(transition, axis=0)
            values = repeated[row]+transition[parents[row], np.arange(len(offsets))]
        selected = np.empty(len(repeated), np.int16)
        selected[-1] = np.argmin(values)
        for row in range(len(repeated)-1, 0, -1):
            selected[row-1] = parents[row, selected[row]]
        delta = offsets[selected[len(points):2*len(points)]]
        if return_observations:
            observations.append((points,normal,delta))
            continue
        shifted = points+delta[:, None]*normal
        polygon = np.rint((shifted+.5)*scale).astype(np.int32)
        depth, parent = 0, int(hierarchy[0, index, 3])
        while parent >= 0:
            depth += 1
            parent = int(hierarchy[0, parent, 3])
        cv2.fillPoly(raster, [polygon], 255 if depth % 2 == 0 else 0)
    if return_observations:
        return observations
    return np.rint(raster.reshape(alpha.shape[0], scale, alpha.shape[1], scale).mean(axis=(1, 3))).astype(np.uint8)


def refine_bounded_matte(source, matte, category, protected_material=None, material=False):
    if source.width * source.height > 4_000_000:
        raise ValueError("MATTE_REFINEMENT_SIZE_LIMIT: select a region below 4 million pixels")
    rgb = np.asarray(source.convert("RGB"))
    original = np.asarray(matte.convert("L"))
    foreground = original >= 128
    if not foreground.any() or foreground.all():
        fail("matte must contain both foreground and background")
    radius = max(6, min(12, round(min(matte.size) * 0.02)))
    inside = nd.distance_transform_edt(foreground)
    outside = nd.distance_transform_edt(~foreground)
    seeds, components, count = component_seeds(foreground, inside, radius)
    background_seeds = (~foreground) & (outside > radius)
    # Background islands need the same erosion protection as thin foreground
    # strokes. Otherwise a narrow, valid letter counter has no definite BG
    # samples and GrabCut can silently fill it. Only its deepest core is fixed;
    # its boundary can still align to the source. These constrain the observed
    # color model only; the complete counter is carried by the shape transform.
    protected_background, _, _ = component_seeds(~foreground, outside, radius)
    if not seeds.any() or not background_seeds.any():
        fail("not enough foreground/background evidence for bounded refinement")
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    refined = np.zeros_like(foreground)
    observed_shape = np.zeros_like(foreground)
    fitted_alpha = np.zeros_like(original)
    fitted_region = np.zeros_like(foreground)
    fitted_evidence = np.zeros_like(foreground)
    fitted_colors = rgb.astype(float)
    shape_alpha = np.zeros_like(original, dtype=np.float32)
    # Separate color models: pale type must not compete with black type elsewhere
    # in the same crop. Padding supplies local rather than page-wide background.
    for component_id, box in enumerate(nd.find_objects(components), 1):
        if box is None:
            continue
        roi = tuple(slice(max(0, item.start-2*radius), min(foreground.shape[axis], item.stop+2*radius))
                    for axis, item in enumerate(box))
        component = components[roi] == component_id
        local_outside = nd.distance_transform_edt(~component)
        projected = local_plane_matte(rgb[roi], component, seeds[roi], background_seeds[roi], radius)
        # A color fit cannot overrule the independent source inspection. Dark
        # material can lie on the same color line as alpha, including alpha=0.
        # Fall back to the shape/trimap path instead of re-cutting repaired holes.
        if projected is not None and protected_material is not None:
            protected = protected_material[roi] & component
            if np.any(projected[0][protected] < 255):
                projected = None
        if projected is not None:
            component_alpha, evidence, colors = projected
            region = local_outside <= radius
            owned = component_alpha > fitted_alpha[roi]
            fitted_colors[roi][owned] = colors[owned]
            fitted_alpha[roi] = np.maximum(fitted_alpha[roi], component_alpha)
            fitted_region[roi] |= region
            fitted_evidence[roi] |= evidence & region
            refined[roi] |= component_alpha >= 128
            observed_shape[roi] |= component_alpha >= 128
            continue
        labels = np.where(component, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
        labels[seeds[roi] & component] = cv2.GC_FGD
        labels[local_outside > radius] = cv2.GC_BGD
        labels[protected_background[roi]] = cv2.GC_BGD
        cv2.grabCut(np.ascontiguousarray(rgb[roi]), labels, None,
                    np.zeros((1, 65)), np.zeros((1, 65)), 3, cv2.GC_INIT_WITH_MASK)
        observed = (labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD)
        observed_shape[roi] |= observed
        # Keep antialias coverage from the proposal, discard model gray noise.
        # The nearest component owns its one-pixel edge, not adjacent glyphs.
        near = nd.distance_transform_edt(~component) <= 1.5
        clean = np.clip((original[roi].astype(float)-8)/239,0,1)*255
        clean[~near] = 0
        component_alpha = align_component_shape(clean, observed, radius)
        shape_alpha[roi] = np.maximum(shape_alpha[roi],component_alpha)
        refined[roi] |= component_alpha >= .5
    changed = refined != foreground
    # Large corrections are not trustworthy; do not silently invent another object.
    changed_ratio = float(changed.sum() / foreground.sum())
    if changed_ratio > 0.25:
        fail("correction exceeds 25% of the proposed object")
    if np.any(refined[background_seeds]):
        fail("refinement escaped its frozen trimap")

    # Keep shape coverage separate from source RGB recovery. A second color-
    # based alpha estimate here used to refill holes and add jagged edge pixels.
    inner_distance = nd.distance_transform_edt(refined)
    outer_distance = nd.distance_transform_edt(~refined)
    fg_samples, _, _ = component_seeds(refined, inner_distance, 1.5)
    bg_samples = (~refined) & (outer_distance > 1.5)
    alpha = shape_alpha.copy()
    recovered_rgb = rgb.astype(float)
    if bg_samples.any():
        fi = nd.distance_transform_edt(~fg_samples, return_distances=False, return_indices=True)
        bi = nd.distance_transform_edt(~bg_samples, return_distances=False, return_indices=True)
        f = rgb[tuple(fi)].astype(np.float32)
        b = rgb[tuple(bi)].astype(np.float32)
        color = rgb.astype(np.float32)
        delta = f - b
        denominator = np.sum(delta * delta, axis=2)
        blend = np.clip(np.sum((color - b) * delta, axis=2) / np.maximum(denominator, 1), 0, 1)
        residual = np.sqrt(np.mean((color - (b + blend[..., None] * delta)) ** 2, axis=2))
        edge_band = (inner_distance <= 1.5) & (outer_distance <= 1.5)
        supported = edge_band & (denominator >= 6 ** 2) & (residual <= np.maximum(2, np.sqrt(denominator) * .1))
        # Never add soft pixels beyond the authorized correction band.
        supported &= ~background_seeds
        # Do not let color estimation change a validated contour or counter.
        # Its job is foreground-color recovery, not a second segmentation pass.
        soft = supported & (alpha > 0) & (alpha < 1)
        # Recover straight foreground RGB before attaching alpha. Source pixels
        # already contain the old background; copying them creates a second blend.
        recovered_rgb[soft] = f[soft]
    alpha = np.rint(alpha * 255).astype(np.uint8)
    alpha[alpha <= 8] = 0
    alpha[alpha >= 247] = 255
    fitted_region &= (fitted_alpha > 0) | ~refined
    alpha[fitted_region] = fitted_alpha[fitted_region]
    recovered_rgb[fitted_region] = fitted_colors[fitted_region]
    recovered_rgb[(alpha == 0) | (alpha == 255)] = rgb[(alpha == 0) | (alpha == 255)]

    # Validate, repair a bounded local registration error, and validate again.
    # The stopping condition remains source evidence, not a retry count or UI flag.
    visible = alpha >= 128
    measurement, unsupported = source_contour_evidence(rgb,visible,fitted_evidence, material=material, alpha=alpha)
    repair = {'applied':False,'changedPixels':0}
    if measurement['longestUnsupportedRun'] > 12 or measurement['boundaryMatchRatio'] < .9:
        sizes = np.bincount(unsupported.ravel())
        uncertain = (unsupported>0)&(sizes[unsupported]>12)
        repaired = align_uncertain_segments(alpha,observed_shape,uncertain)
        repaired_visible = repaired >= 128
        holes = nd.binary_fill_holes(visible)&~visible
        repaired_holes = nd.binary_fill_holes(repaired_visible)&~repaired_visible
        topology_preserved = (nd.label(visible)[1] == nd.label(repaired_visible)[1]
                              and nd.label(holes)[1] == nd.label(repaired_holes)[1])
        within_scope = not np.any((repaired>0)&background_seeds)
        if topology_preserved and within_scope and not np.array_equal(alpha,repaired):
            checked,_ = source_contour_evidence(rgb,repaired_visible,fitted_evidence, material=material, alpha=repaired)
            if (checked['longestUnsupportedRun'] < measurement['longestUnsupportedRun']
                    and checked['boundaryMatchRatio'] >= measurement['boundaryMatchRatio']):
                repair = {'applied':True,'changedPixels':int(np.count_nonzero(alpha!=repaired)),
                          'beforeLongestUnsupportedRun':measurement['longestUnsupportedRun'],
                          'method':'source_observed_segment_registration','maximumShiftPixels':4}
                changed_alpha = alpha != repaired
                alpha, visible, measurement = repaired, repaired_visible, checked
                # Recover color for newly exposed soft pixels from definite
                # source foreground, without changing opaque material pixels.
                inner = nd.distance_transform_edt(visible)
                samples,_,_ = component_seeds(visible,inner,1.5)
                nearest = nd.distance_transform_edt(~samples,return_distances=False,return_indices=True)
                changed_soft = (alpha>0)&(alpha<255)&changed_alpha
                recovered_rgb[changed_soft] = rgb[tuple(nearest)][changed_soft]
                refined = visible.copy()
    if measurement['longestUnsupportedRun'] > 12 or measurement['boundaryMatchRatio'] < .9:
        registered = register_source_contours(rgb, alpha, radius, observed_shape)
        registered_visible = registered >= 128
        holes = nd.binary_fill_holes(visible)&~visible
        registered_holes = nd.binary_fill_holes(registered_visible)&~registered_visible
        topology_preserved = (nd.label(visible)[1] == nd.label(registered_visible)[1]
                              and nd.label(holes)[1] == nd.label(registered_holes)[1])
        if topology_preserved and not np.any((registered>0)&background_seeds):
            checked, _ = source_contour_evidence(rgb, registered_visible, fitted_evidence, material=True, alpha=registered)
            if (checked['longestUnsupportedRun'] < measurement['longestUnsupportedRun']
                    and checked['boundaryMatchRatio'] >= measurement['boundaryMatchRatio']):
                repair = {'applied':True, 'changedPixels':int(np.count_nonzero(alpha!=registered)),
                          'beforeLongestUnsupportedRun':measurement['longestUnsupportedRun'],
                          'method':'source_normal_registration', 'maximumShiftPixels':radius}
                changed_soft = (registered>0)&(registered<255)&(alpha!=registered)
                alpha, visible, measurement = registered, registered_visible, checked
                samples,_,_ = component_seeds(visible, nd.distance_transform_edt(visible), 1.5)
                nearest = nd.distance_transform_edt(~samples, return_distances=False, return_indices=True)
                recovered_rgb[changed_soft] = rgb[tuple(nearest)][changed_soft]
                refined = visible.copy()
    recovered_rgb[(alpha==0)|(alpha==255)] = rgb[(alpha==0)|(alpha==255)]
    changed = visible != foreground
    changed_ratio = float(changed.sum()/foreground.sum())
    if changed_ratio > .25:
        fail('local correction exceeds 25% of the proposed object')
    integrity = alpha_contour_integrity(refined,alpha)
    reasons = []
    if measurement['boundaryMatchRatio'] < .9 or measurement['longestUnsupportedRun'] > 12:
        reasons.append("SOURCE_BOUNDARY_UNCERTAIN")
    if integrity["status"] != "passed":
        reasons.append("ALPHA_CONTOUR_CHANGED")
    verified = not reasons
    surviving = np.unique(components[visible])
    if np.count_nonzero(surviving) != count:
        fail("refinement removed a selected component")
    audit = {"policyVersion": 7, "method": "source_guided_matte", "status": "passed" if verified else "needs_review",
             "reviewReasons": reasons, "contourIntegrity": integrity,
             "radiusPixels": radius, "changedPixels": int(changed.sum()), "changedAreaRatio": round(changed_ratio, 6),
             **measurement, "minimumRatio": .9, "maximumUnsupportedRun": 12, "localContourRepair":repair}
    return Image.fromarray(alpha), audit, Image.fromarray(np.rint(recovered_rgb).astype(np.uint8))
