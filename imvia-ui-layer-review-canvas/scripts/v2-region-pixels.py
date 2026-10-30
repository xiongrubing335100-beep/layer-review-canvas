#!/usr/bin/env python3
"""Deterministic V2 selected-region PNG finalizer; no model or network calls."""
import argparse
import json
import math
import re
import sys
import importlib.util
import hashlib
from pathlib import Path

from PIL import Image


def fail(code, message=None):
    raise ValueError(f"{code}: {message or code}")


def inside_root(root, target):
    root = Path(root).resolve()
    target = Path(target).resolve()
    if root != target and root not in target.parents:
        fail("PATH_ESCAPES_ROOT", str(target))
    return target


def bezier_points(path):
    anchors = path.get("anchors", [])
    if len(anchors) < 3 or not path.get("closed"):
        fail("INVALID_CLOSED_PATH")
    points = []

    def midpoint(a, b):
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)

    def distance_to_segment(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        denominator = dx * dx + dy * dy
        t = max(0, min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / denominator)) if denominator else 0
        return math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy)

    def flatten(a, b, c, d, depth=0):
        # Bound geometric error in source pixels, regardless of curve size.
        if depth >= 16 or max(distance_to_segment(b, a, d), distance_to_segment(c, a, d)) <= 1/32:
            points.append(a)
            return
        ab, bc, cd = midpoint(a, b), midpoint(b, c), midpoint(c, d)
        abc, bcd = midpoint(ab, bc), midpoint(bc, cd)
        middle = midpoint(abc, bcd)
        flatten(a, ab, abc, middle, depth + 1)
        flatten(middle, bcd, cd, d, depth + 1)

    for index, start in enumerate(anchors):
        end = anchors[(index + 1) % len(anchors)]
        p0 = (float(start["x"]), float(start["y"]))
        p1 = (float(start["out"]["x"]), float(start["out"]["y"]))
        p2 = (float(end["in"]["x"]), float(end["in"]["y"]))
        p3 = (float(end["x"]), float(end["y"]))
        flatten(p0, p1, p2, p3)
    return points


def path_mask(paths, bounds):
    width, height = bounds["width"], bounds["height"]
    included = [path for path in paths if path.get("kind") == "include"]
    excluded = [path for path in paths if path.get("kind") == "exclude"]
    if not included and not excluded:
        return Image.new("L", (width, height), 255)
    import numpy as np
    polygons = []
    for item in included + excluded:
        points = np.array(bezier_points(item)) - [bounds["x"], bounds["y"]]
        ends = np.roll(points, -1, axis=0)
        edges = np.column_stack((points, ends))
        polygons.append((edges[edges[:, 1] != edges[:, 3]], 0 if item.get("kind") == "exclude" else 1))
    scale = 8
    result = np.empty((height, width), dtype=np.uint8)
    # Scan source-pixel footprints in strips, not a whole 64x larger image.
    # Half-open spans preserve bounds; nonzero winding matches the editor fill.
    for top in range(0, height, 32):
        count = min(32, height - top)
        samples = np.full((count * scale, width * scale), 0 if included else 1, dtype=np.uint8)
        for edges, fill in polygons:
            for row in range(count * scale):
                y = top + (row + .5) / scale
                active = edges[(np.minimum(edges[:, 1], edges[:, 3]) <= y) & (y < np.maximum(edges[:, 1], edges[:, 3]))]
                if not len(active):
                    continue
                crossings = active[:, 0] + (y-active[:, 1]) * (active[:, 2]-active[:, 0]) / (active[:, 3]-active[:, 1])
                winding, left = 0, 0
                for index in np.argsort(crossings):
                    x = crossings[index]
                    if winding:
                        start = max(0, min(width * scale, math.ceil(left * scale - .5)))
                        stop = max(0, min(width * scale, math.ceil(x * scale - .5)))
                        samples[row, start:stop] = fill
                    winding += 1 if active[index, 3] > active[index, 1] else -1
                    left = x
        result[top:top + count] = np.rint(samples.reshape(count, scale, width, scale).mean(axis=(1, 3)) * 255).astype(np.uint8)
    return Image.fromarray(result)


def matte_mask(path, mapping, expected_size, provider):
    matte = Image.open(path)
    if matte.width * matte.height > 40_000_000:
        fail("MATTE_TOO_LARGE")
    rgba = matte.convert("RGBA")
    if provider == "imagegen_matte":
        region = mapping.get("contentRegion") if mapping else None
        source_region = mapping.get("sourceRegion") if mapping else None
        canvas = mapping.get("canvas") if mapping else None
        if mapping:
            validate_mapping(mapping, rgba.size, expected_size)
        if region and source_region and canvas and (matte.width, matte.height) == (canvas["width"], canvas["height"]):
            if (source_region["width"], source_region["height"]) != expected_size:
                fail("MAPPING_SOURCE_SIZE_MISMATCH")
            # A matte is pixel coverage, not a point-sampled color texture.
            # Integrate each destination pixel's footprint before quantization;
            # sampling one point loses small strokes and curved-edge coverage.
            import cv2
            import numpy as np
            content = rgba.crop((region["x"], region["y"],
                                 region["x"] + region["width"], region["y"] + region["height"]))
            values = np.asarray(content, dtype=np.float32)[..., :3]
            coverage = values @ np.array([.2126, .7152, .0722], dtype=np.float32)
            width, height = expected_size
            if width != coverage.shape[1]:
                coverage = cv2.resize(coverage, (width, coverage.shape[0]),
                                      interpolation=cv2.INTER_AREA if width < coverage.shape[1] else cv2.INTER_LINEAR)
            if height != coverage.shape[0]:
                coverage = cv2.resize(coverage, (width, height),
                                      interpolation=cv2.INTER_AREA if height < coverage.shape[0] else cv2.INTER_LINEAR)
            return Image.fromarray(np.rint(np.clip(coverage, 0, 255)).astype(np.uint8))
        if rgba.size != expected_size:
            fail("MAPPING_REQUIRED_FOR_PADDED_MATTE")
        return rgba.convert("RGB").convert("L")
    if rgba.size != expected_size:
        fail("MATTE_DIMENSIONS_MISMATCH")
    # RGBA providers encode coverage only in alpha. Treating opaque RGB as a
    # grayscale mask invents transparency and disguises failed background removal.
    return rgba.getchannel("A")


def validate_mapping(mapping, image_size, expected_size):
    if not mapping or not mapping.get("contentRegion") or not mapping.get("canvas") or not mapping.get("sourceRegion"):
        fail("MAPPING_REQUIRED_FOR_PADDED_IMAGE")
    if (mapping["sourceRegion"]["width"], mapping["sourceRegion"]["height"]) != expected_size:
        fail("MAPPING_SOURCE_SIZE_MISMATCH")
    canvas = mapping["canvas"]
    region = mapping["contentRegion"]
    if (not all(type(value) is int for value in [region.get("x"), region.get("y"), region.get("width"), region.get("height"), canvas.get("width"), canvas.get("height")])
            or region["x"] < 0 or region["y"] < 0 or min(region["width"], region["height"], canvas["width"], canvas["height"]) <= 0
            or region["x"] + region["width"] > canvas["width"] or region["y"] + region["height"] > canvas["height"]):
        fail("INVALID_REFERENCE_MAPPING")
    if image_size != (canvas["width"], canvas["height"]):
        fail("MAPPING_CANVAS_SIZE_MISMATCH")


def inverse_mapped_region(image, mapping, expected_size):
    validate_mapping(mapping, image.size, expected_size)
    region = mapping["contentRegion"]
    import cv2
    import numpy as np
    content = image.crop((region["x"], region["y"], region["x"] + region["width"], region["y"] + region["height"])).convert("RGBA")
    if content.size == expected_size:
        return content
    values = np.asarray(content, dtype=np.float32).copy()
    # Filter premultiplied color so transparent padding cannot add a dark/color
    # fringe. Integrate shrinking footprints and interpolate enlargements.
    values[..., :3] *= values[..., 3:4] / 255
    width, height = expected_size
    if width != values.shape[1]:
        values = cv2.resize(values, (width, values.shape[0]), interpolation=cv2.INTER_AREA if width < values.shape[1] else cv2.INTER_LINEAR)
    if height != values.shape[0]:
        values = cv2.resize(values, (width, height), interpolation=cv2.INTER_AREA if height < values.shape[0] else cv2.INTER_LINEAR)
    alpha = values[..., 3:4]
    values[..., :3] = np.divide(values[..., :3] * 255, alpha, out=np.zeros_like(values[..., :3]), where=alpha > 0)
    return Image.fromarray(np.rint(np.clip(values, 0, 255)).astype(np.uint8))


def native_boundary_repair_mask(base, aligned):
    """Bound RGB repair to observed disagreement near the proposed silhouette.

    Never changes alpha or moves source pixels. This is not a segmentation
    certificate: the final composited preview still needs silhouette inspection.
    """
    import cv2
    import numpy as np
    source = np.asarray(base, dtype=np.int16)
    proposed = np.asarray(aligned, dtype=np.int16)
    visible = proposed[..., 3] > 0
    solid = (proposed[..., 3] >= 128).astype(np.uint8)
    distance = cv2.distanceTransform(np.pad(solid, 1), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)[1:-1,1:-1]
    radius = max(2, min(8, int(np.ceil(min(base.size)/128))))
    band = visible & (distance <= radius)
    disagreement = np.max(np.abs(source[...,:3] - proposed[...,:3]), axis=2) > 32
    seeds = (band & disagreement).astype(np.uint8)
    # Full correction at observed discrepancies, short transition around them.
    nearby = cv2.GaussianBlur(seeds.astype(np.float32), (5,5), .8)
    # Fade toward unchanged interior so a patch cannot end at a hard band seam.
    inward_fade = np.clip((radius-distance) / max(1, radius-1), 0, 1)
    weights = np.maximum(seeds, nearby) * band * inward_fade
    return Image.fromarray(np.rint(weights*255).astype(np.uint8))


def alpha_state(alpha, remove_background):
    low, high = alpha.getextrema()
    if high == 0:
        fail("ALL_TRANSPARENT")
    status = "needs_review" if remove_background and low == 255 and high == 255 else "candidate"
    return {"min": low, "max": high, "status": status}


def render_region(manifest, raw_path, matte_path=None, *, _defer_component_contour=False,
                  _required_component_region=None, _component_anchor=None):
    """One pixel implementation for inspection and final delivery; no writes."""
    repair = manifest.get('scopedNativeRepair')
    if repair:
        strategy = manifest.get('snapshot', {}).get('strategy', {})
        if (manifest.get('maskProvider') != 'native_rgba' or manifest.get('maximumImagegenCalls') != 2
                or strategy.get('localRepairPolicy') != 'scoped_once_v1'
                or strategy.get('fidelityPolicy') != 'source_faithful_repair' or matte_path):
            fail('REPAIR_BUDGET_NOT_AUTHORIZED')
        root = manifest['outputRoot']
        initial_path = inside_root(root, raw_path)
        repair_path = inside_root(root, repair['rawPath'])
        if (hashlib.sha256(initial_path.read_bytes()).hexdigest() != repair['parentRawSha256']
                or hashlib.sha256(repair_path.read_bytes()).hexdigest() != repair['rawSha256']):
            fail('REPAIR_RAW_BINDING_MISMATCH')
        base_manifest = {k:v for k,v in manifest.items() if k != 'scopedNativeRepair'}
        initial, audit = render_region(base_manifest, initial_path, _defer_component_contour=True)
        snapshot = manifest['snapshot']; bounds = snapshot['bounds']
        permission = path_mask(snapshot.get('paths', []), bounds)
        if strategy.get('repairPaths'):
            import numpy as np
            permission = Image.fromarray(np.minimum(np.array(permission), np.array(path_mask(strategy['repairPaths'], bounds))))
        spec = importlib.util.spec_from_file_location('scoped_native', Path(__file__).with_name('scoped-native-repair.py'))
        scoped = importlib.util.module_from_spec(spec); spec.loader.exec_module(scoped)
        # Validate scope before any corrected-image registration, using the
        # same permission and area rules as the final merge.
        import numpy as np
        scope_probe = Image.new('RGBA', initial.size, (255, 255, 255, 255))
        scope_zero = Image.new('RGBA', initial.size, (0, 0, 0, 0))
        scope_image, _ = scoped.merge_scoped_repair(scope_zero, scope_probe, repair['defects'], permission)
        corrected, corrected_audit = render_region(
            base_manifest, repair_path, _defer_component_contour=True,
            _required_component_region=(np.asarray(scope_image)[..., 3] == 255
                if audit.get('nativeAlignment', {}).get('method') == 'bounded_component_source_edges' else None),
            _component_anchor=audit.get('nativeAlignment', {}).get('anchorMatrix'))
        source_image = Image.open(inside_root(root, manifest['selectedCropPath'])).convert('RGB')
        result, scope_audit = scoped.merge_scoped_repair(
            initial, corrected, repair['defects'], permission, source=source_image)
        if any(item.get('nativeAlignment', {}).get('method') == 'bounded_component_source_edges'
               for item in (audit, corrected_audit)):
            # Only the bounded merge may replace a rejected intermediate
            # contour. Inspect the entire delivered silhouette, including
            # the immutable exterior, with the same source-quality gates.
            import numpy as np
            from scipy import ndimage
            before_solid = np.asarray(initial)[..., 3] >= 128
            after_solid = np.asarray(result)[..., 3] >= 128
            before_holes, count = ndimage.label(ndimage.binary_fill_holes(before_solid) & ~before_solid)
            after_holes = ndimage.binary_fill_holes(after_solid) & ~after_solid
            allowed_fill = np.zeros(before_solid.shape, bool)
            for defect in repair['defects']:
                if defect.get('kind') == 'false_hole':
                    x, y, w, h = (defect[k] for k in ('x', 'y', 'width', 'height'))
                    allowed_fill[y:y+h, x:x+w] = True
            for hole in range(1, count+1):
                pixels = before_holes == hole
                if not (pixels & after_holes).any() and (pixels & ~allowed_fill).any():
                    fail('SCOPED_REPAIR_SOURCE_CONTOUR_HOLE_LOST')
            spec = importlib.util.spec_from_file_location(
                'scoped_source_evidence', Path(__file__).with_name('source-guided-matte.py'))
            evidence = importlib.util.module_from_spec(spec); spec.loader.exec_module(evidence)
            source = np.asarray(Image.open(inside_root(root, manifest['selectedCropPath'])).convert('RGB'))
            alpha = np.asarray(result)[..., 3]
            contour, _ = evidence.source_contour_evidence(
                source, alpha >= 128, np.zeros(alpha.shape, bool), material=True, alpha=alpha)
            if contour['boundaryMatchRatio'] < .9 or contour['longestUnsupportedRun'] > 12:
                error = ValueError('SCOPED_REPAIR_SOURCE_CONTOUR: ' + json.dumps(contour))
                error.diagnostic_result = result
                error.diagnostic_audit = {'sourceContour': contour, 'scope': scope_audit}
                raise error
            scope_audit['sourceContour'] = contour
        audit['scopedRepair'] = {**scope_audit, 'requestSha256':repair.get('requestSha256'),
            'parentRawSha256':repair['parentRawSha256'],'rawSha256':repair['rawSha256'],
            'nativeAlignment':corrected_audit.get('nativeAlignment')}
        audit['alpha'] = alpha_state(result.getchannel('A'), bool(manifest.get('removeBackground')))
        audit['status'] = audit['alpha']['status']
        # Counts must describe the delivered merge, not either intermediate.
        import numpy as np
        original = np.array(Image.open(inside_root(root,manifest['selectedCropPath'])).convert('RGBA'))
        output = np.array(result); foreground=output[:,:,3]>=128
        same=np.all(original[:,:,:3]==output[:,:,:3],axis=2)
        audit['localRepair'] = {**audit.get('localRepair',{}),
            'foregroundPixels':int(foreground.sum()),'unchangedForegroundRgbPixels':int((same&foreground).sum()),
            'changedRgbPixels':int((~same).sum())}
        return result, audit
    if manifest.get("schemaVersion") != 2 or manifest.get("route") not in ("extract_mask", "reconstruct"):
        fail("INVALID_PROCESSING_MANIFEST")
    snapshot = manifest.get("snapshot") or {}
    bounds = snapshot.get("bounds") or {}
    width, height = bounds.get("width"), bounds.get("height")
    if not all(isinstance(value, int) and value > 0 for value in (width, height)):
        fail("INVALID_REGION_BOUNDS")
    root = Path(manifest["outputRoot"]).resolve()
    crop_path = inside_root(root, manifest["selectedCropPath"])
    raw_path = inside_root(root, raw_path)
    matte_path = inside_root(root, matte_path) if matte_path else None
    mapping_path = inside_root(root, manifest["mappingPath"]) if manifest.get("mappingPath") else None
    base = Image.open(crop_path).convert("RGBA")
    if base.size != (width, height):
        fail("SELECTED_CROP_DIMENSIONS_MISMATCH")
    raw = Image.open(raw_path).convert("RGBA")
    native_alignment = None
    local_repair_audit = None
    if manifest["route"] == "reconstruct":
        space = manifest.get("rawCoordinateSpace")
        if space == "reference_canvas" or (space is None and raw.size != (width, height)):
            mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path else manifest.get("mapping")
            if manifest.get('maskProvider') == 'native_rgba':
                validate_mapping(mapping, raw.size, (width, height))
                reference_path = inside_root(root, manifest['referencePath'])
                spec = importlib.util.spec_from_file_location('native_registration', Path(__file__).with_name('native-rgba-registration.py'))
                registration = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(registration)
                matrix, native_alignment = registration.estimate_alignment(Image.open(reference_path), raw,
                    source_crop=base, mapping=mapping, defer_component_contour=_defer_component_contour,
                    required_region=_required_component_region, component_anchor=_component_anchor)
                raw = registration.sample_aligned(raw, matrix, mapping, (width, height))
            else:
                raw = inverse_mapped_region(raw, mapping, (width, height))
        elif raw.size != (width, height):
            fail("GENERATED_REGION_DIMENSIONS_MISMATCH")
    if manifest["route"] == "extract_mask":
        geometry_alignment = None
        recovered_rgb = None
        if manifest.get("maskProvider") == "selection":
            mask = path_mask(snapshot.get("paths", []), bounds)
        elif manifest.get("removeBackground"):
            matte_path = matte_path or (raw_path if manifest.get("maskProvider") == "imagegen_matte" else None)
            if not matte_path:
                fail("MATTE_REQUIRED")
            mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path else manifest.get("mapping")
            mask = matte_mask(matte_path, mapping, (width, height), manifest.get("maskProvider"))
            if manifest.get('semanticRequirements', {}).get('version') == 1 and not manifest.get('semanticTopology'):
                fail('SEMANTIC_REVIEW_REQUIRED')
            if manifest.get("maskProvider") == "imagegen_matte" and snapshot.get("processingCategory") in ("text", "brand_ui"):
                spec = importlib.util.spec_from_file_location("source_guided_matte", Path(__file__).with_name("source-guided-matte.py"))
                refiner = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(refiner)
                mask, geometry_alignment, recovered_rgb = refiner.refine_source_matte(
                    base, mask, snapshot["processingCategory"],
                    scope=path_mask(snapshot.get("paths", []), bounds), recover_foreground=True,
                    semantic_topology=manifest.get('semanticTopology'))
            path_limit = path_mask(snapshot.get("paths", []), bounds)
            mask = Image.frombytes("L", mask.size, bytes(min(a, b) for a, b in zip(mask.tobytes(), path_limit.tobytes())))
        else:
            matte_path = matte_path
            if not matte_path:
                fail("MATTE_REQUIRED")
            mask = matte_mask(matte_path, None, (width, height), manifest.get("maskProvider"))
        result = base.copy()
        if recovered_rgb is not None:
            # Source RGBA is already straight-alpha where it is transparent. Only
            # decontaminate soft cutout edges from previously opaque source pixels.
            corrected = recovered_rgb.load(); output = result.load(); mask_pixels = mask.load()
            recovered_count = 0
            for y in range(height):
                for x in range(width):
                    if output[x, y][3] == 255 and 0 < mask_pixels[x, y] < 255:
                        if output[x, y][:3] != corrected[x, y]:
                            recovered_count += 1
                        output[x, y] = (*corrected[x, y], 255)
            geometry_alignment["edgeColorRecoveryPixels"] = recovered_count
        result.putalpha(Image.frombytes("L", (width, height), bytes(round(a * b / 255) for a, b in zip(base.getchannel("A").tobytes(), mask.tobytes()))))
        rgb_source = "frozen_crop_with_source_edge_recovery" if recovered_rgb is not None else "frozen_crop"
    else:
        allowed = path_mask(snapshot.get("strategy", {}).get("repairPaths", []), bounds)
        native_version = manifest.get('nativeRgbaRequirements', {}).get('version')
        local_native = (manifest.get('maskProvider') == 'native_rgba' and native_version in (2, 3))
        automatic_pixels = 0
        if local_native and not snapshot.get('strategy', {}).get('repairPaths'):
            # Empty extraction scope means the whole crop; empty RGB repair
            # scope means NO replacement. These are deliberately independent.
            allowed = Image.new('L', (width, height), 0)
            if native_version == 3 and manifest.get('removeBackground'):
                allowed = native_boundary_repair_mask(base, raw)
                automatic_pixels = sum(value > 0 for value in allowed.tobytes())
        if manifest.get("maskProvider") == "native_rgba":
            if matte_path:
                fail("NATIVE_RGBA_SECOND_MATTE_FORBIDDEN")
            alpha = raw.getchannel("A")
        elif manifest.get("removeBackground"):
            if not matte_path:
                fail("MATTE_REQUIRED")
            mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path else manifest.get("mapping")
            alpha = matte_mask(matte_path, mapping, (width, height), manifest.get("maskProvider"))
        else:
            alpha = raw.getchannel("A")
        original = base.load(); generated = raw.load(); alpha_pixels = alpha.load(); allowed_pixels = allowed.load()
        result = base.copy(); result_pixels = result.load()
        for y in range(height):
            for x in range(width):
                coverage = allowed_pixels[x, y]
                if local_native:
                    old, new = original[x, y], generated[x, y]
                    weight = coverage / 255
                    rgb = tuple(round(old[c] * (1-weight) + new[c] * weight) for c in range(3))
                    # Cutout alpha applies outside repair patches as well. Source
                    # transparency is retained unless the patch allows filling it.
                    source_alpha = old[3] * (1-weight) + 255 * weight
                    cutout_alpha = alpha_pixels[x, y] if manifest.get('removeBackground') else 255
                    result_pixels[x, y] = (*rgb, round(source_alpha * cutout_alpha / 255))
                elif coverage == 255:
                    result_pixels[x, y] = (*generated[x, y][:3], alpha_pixels[x, y])
                elif coverage:
                    weight = coverage / 255
                    old, new = original[x, y], generated[x, y]
                    old_weight, new_weight = old[3] * (1-weight), alpha_pixels[x, y] * weight
                    alpha = old_weight + new_weight
                    rgb = tuple(round((old[c]*old_weight + new[c]*new_weight) / alpha) if alpha else 0 for c in range(3))
                    result_pixels[x, y] = (*rgb, round(alpha))
        rgb_source = "native_rgba_inside_repair_mask" if manifest.get("maskProvider") == "native_rgba" else "generated_inside_repair_mask"
        if local_native:
            changed = outside_changed = repair_count = 0
            foreground_count = unchanged_foreground = 0
            for y in range(height):
                for x in range(width):
                    differs = result_pixels[x, y][:3] != original[x, y][:3]
                    changed += differs
                    repair_count += allowed_pixels[x, y] > 0
                    outside_changed += differs and allowed_pixels[x, y] == 0
                    if result_pixels[x, y][3] >= 128:
                        foreground_count += 1
                        unchanged_foreground += not differs
            rgb_source = 'frozen_crop_with_local_native_repair'
            local_repair_audit = {'version': native_version, 'repairPixels': repair_count,
                                  'automaticRepairPixels': automatic_pixels,
                                  'changedRgbPixels': changed,
                                  'foregroundPixels': foreground_count,
                                  'unchangedForegroundRgbPixels': unchanged_foreground,
                                  'outsideRepairRgbIdentical': outside_changed == 0}
        if manifest.get('maskProvider') == 'native_rgba' and snapshot.get('paths'):
            scope = path_mask(snapshot['paths'], bounds)
            result.putalpha(Image.frombytes('L', result.size, bytes(min(a, b) for a, b in
                zip(result.getchannel('A').tobytes(), scope.tobytes()))))
    alpha_info = alpha_state(result.getchannel("A"), bool(manifest.get("removeBackground")))
    if manifest["route"] == "extract_mask" and geometry_alignment and geometry_alignment["status"] != "passed":
        alpha_info["status"] = "needs_review"
    audit = {"status": alpha_info["status"], "width": width, "height": height, "placement": {"x": bounds["x"], "y": bounds["y"]},
        "alpha": alpha_info, "rgbSource": rgb_source, "route": manifest["route"], "maskProvider": manifest.get("maskProvider")}
    if native_alignment is not None:
        audit['nativeAlignment'] = native_alignment
    if local_repair_audit is not None:
        audit['localRepair'] = local_repair_audit
    if manifest["route"] == "extract_mask" and geometry_alignment is not None:
        audit["sourceGeometryAlignment"] = geometry_alignment
        if geometry_alignment.get('semanticTopology'):
            audit['semanticTopology'] = geometry_alignment['semanticTopology']
    return result, audit


def run(args):
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.setdefault('outputRoot', str(manifest_path.parent.parent))
    output_path = inside_root(manifest['outputRoot'], args.output)
    if output_path.exists():
        fail("OUTPUT_ALREADY_EXISTS")
    result, audit = render_region(manifest, args.raw, args.matte)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('xb') as output:
        result.save(output, format="PNG", optimize=False)
    if manifest.get("reportPath"):
        Path(manifest["reportPath"]).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return audit


def decode_png(args):
    source = Path(args.decode_png).resolve()
    target = Path(args.output).resolve()
    if target.exists():
        fail("OUTPUT_ALREADY_EXISTS")
    with Image.open(source) as image:
        image.verify()
    with Image.open(source) as image:
        if image.size != (args.expected_width, args.expected_height):
            fail("PNG_DIMENSIONS_MISMATCH")
        rgba = image.convert("RGBA")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as handle:
            handle.write(rgba.tobytes())
    return {"width": args.expected_width, "height": args.expected_height, "channels": 4, "format": "RGBA"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest")
    parser.add_argument("--raw")
    parser.add_argument("--matte")
    parser.add_argument("--output", required=True)
    parser.add_argument("--decode-png")
    parser.add_argument("--expected-width", type=int)
    parser.add_argument("--expected-height", type=int)
    args = parser.parse_args()
    try:
        if args.decode_png:
            if not args.expected_width or not args.expected_height:
                fail("EXPECTED_DIMENSIONS_REQUIRED")
            result = decode_png(args)
        else:
            if not args.manifest or not args.raw:
                fail("MANIFEST_AND_RAW_REQUIRED")
            result = run(args)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:  # CLI contract emits a machine-readable failure code on stderr.
        message = str(error)
        match = re.match(r"^([A-Z][A-Z0-9_]+)(?::|$)", message)
        code = match.group(1) if match else "PIXEL_PROCESSING_FAILED"
        print(json.dumps({"code": code, "message": message, "stage": "pixel_finalization"}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
