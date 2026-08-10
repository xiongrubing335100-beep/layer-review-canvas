import json
import math
import os
from collections.abc import Mapping
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat

try:
    from scripts.safe_layer_path import contained_child, safe_layer_id
except ModuleNotFoundError:
    from safe_layer_path import contained_child, safe_layer_id


LANDSCAPE_CANVAS = (1536, 1024)
PORTRAIT_CANVAS = (1024, 1536)
SQUARE_CANVAS = (1024, 1024)


def _point_coordinates(point):
    if isinstance(point, Mapping):
        return point["x"], point["y"]
    return point[0], point[1]


def polygon_bounds(points, image_size):
    width, height = image_size
    coordinates = [_point_coordinates(point) for point in points]
    if not coordinates:
        raise ValueError("repair polygon has zero-sized bounds")
    xs = [point[0] for point in coordinates]
    ys = [point[1] for point in coordinates]
    left = max(0, int(math.floor(min(xs))))
    top = max(0, int(math.floor(min(ys))))
    right = min(width, int(math.ceil(max(xs))))
    bottom = min(height, int(math.ceil(max(ys))))
    if right <= left or bottom <= top:
        raise ValueError("repair polygon has zero-sized bounds")
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def padded_region(bounds, image_size, ratio=0.08, minimum=0.03, maximum=0.15):
    ratio = min(max(ratio, minimum), maximum)
    padding = max(1, round(max(bounds["width"], bounds["height"]) * ratio))
    width, height = image_size
    left = max(0, bounds["x"] - padding)
    top = max(0, bounds["y"] - padding)
    right = min(width, bounds["x"] + bounds["width"] + padding)
    bottom = min(height, bounds["y"] + bounds["height"] + padding)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def choose_native_canvas(width, height):
    ratio = width / height
    if ratio > 1.2:
        return LANDSCAPE_CANVAS
    if ratio < 1 / 1.2:
        return PORTRAIT_CANVAS
    return SQUARE_CANVAS


def place_native_region(content_size, canvas_size):
    width, height = content_size
    canvas_width, canvas_height = canvas_size
    if width > canvas_width or height > canvas_height:
        raise ValueError("native ROI does not fit the selected standard canvas")
    return {
        "x": (canvas_width - width) // 2,
        "y": (canvas_height - height) // 2,
        "width": width,
        "height": height,
    }


def tile_region(region, canvas_size, overlap_pixels=32):
    canvas_width, canvas_height = canvas_size
    step_x = max(1, canvas_width - overlap_pixels)
    step_y = max(1, canvas_height - overlap_pixels)
    tiles = []
    y = region["y"]
    while y < region["y"] + region["height"]:
        x = region["x"]
        tile_height = min(canvas_height, region["y"] + region["height"] - y)
        while x < region["x"] + region["width"]:
            tile_width = min(canvas_width, region["x"] + region["width"] - x)
            tiles.append({"x": x, "y": y, "width": tile_width, "height": tile_height})
            if x + tile_width >= region["x"] + region["width"]:
                break
            x += step_x
        if y + tile_height >= region["y"] + region["height"]:
            break
        y += step_y
    return tiles


def _atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _operation(layer):
    value = layer.get("refinement_operation") or {}
    return {
        "mode": value.get("mode"),
        "subject_path_ids": list(value.get("subject_path_ids") or []),
        "alpha_include_path_ids": list(value.get("alpha_include_path_ids") or []),
    }


def _open_base(base_png):
    if isinstance(base_png, Image.Image):
        return base_png.convert("RGBA")
    with Image.open(Path(base_png)) as source:
        if source.format != "PNG":
            raise ValueError("result_refinement base must be a PNG")
        return source.convert("RGBA")


def _validated_path_data(layer, layer_id):
    safe_layer_id(layer_id)
    annotations = layer.get("mask_annotations") or []
    by_id = {}
    for annotation in annotations:
        path_id = safe_layer_id(annotation.get("id"))
        if path_id in by_id:
            raise ValueError(f"duplicate result_refinement path id: {path_id}")
        by_id[path_id] = annotation

    operation = _operation(layer)
    for path_id in operation["subject_path_ids"] + operation["alpha_include_path_ids"]:
        safe_layer_id(path_id)
    repair_ids = list(layer.get("repair_path_ids") or [])
    for path_id in repair_ids:
        safe_layer_id(path_id)
        if path_id not in by_id:
            raise ValueError(f"repair path is missing from mask_annotations: {path_id}")
    if set(repair_ids).intersection(operation["subject_path_ids"]):
        raise ValueError("subject paths cannot also be repair paths")
    return operation, repair_ids, by_id


def build_result_refinement_manifest(
    job_id,
    layer_id,
    layer,
    base_png,
    generated_directory,
):
    operation, repair_ids, annotations = _validated_path_data(layer, layer_id)
    base = _open_base(base_png)
    base_size = base.size
    policy = layer.get("roi_policy") or {}
    padding_ratio = policy.get("context_padding_ratio", 0.08)
    minimum_ratio = policy.get("minimum_padding_ratio", 0.03)
    maximum_ratio = policy.get("maximum_padding_ratio", 0.15)
    overlap_pixels = policy.get("tile_overlap_pixels", 32)
    expected_count = layer.get("expected_roi_tile_count")
    if not isinstance(expected_count, int) or expected_count < 0:
        raise ValueError("expected_roi_tile_count must be a non-negative integer")

    regions = []
    if operation["mode"] == "full_canvas_explicit" and expected_count > 0:
        regions.append(("full-canvas", {
            "x": 0,
            "y": 0,
            "width": base.width,
            "height": base.height,
        }))
    elif operation["mode"] != "full_canvas_explicit":
        for path_id in repair_ids:
            bounds = polygon_bounds(annotations[path_id].get("source_polygon_pixels") or [], base_size)
            regions.append((path_id, padded_region(
                bounds,
                base_size,
                ratio=padding_ratio,
                minimum=minimum_ratio,
                maximum=maximum_ratio,
            )))

    planned_jobs = []
    for path_id, region in regions:
        canvas_size = choose_native_canvas(region["width"], region["height"])
        tiles = tile_region(region, canvas_size, overlap_pixels)
        for tile_index, tile in enumerate(tiles, start=1):
            roi_id = f"{path_id}-tile-{tile_index:03d}"
            reference_filename = f"{layer_id}-{roi_id}-reference.png"
            reference_path = contained_child(generated_directory, reference_filename)
            canvas_region = place_native_region(
                (tile["width"], tile["height"]),
                canvas_size,
            )
            planned_jobs.append({
                "roi_id": roi_id,
                "path_id": path_id,
                "base_region": dict(tile),
                "canvas": {"width": canvas_size[0], "height": canvas_size[1]},
                "content_region": canvas_region,
                "reference_path": str(reference_path),
            })

    if len(planned_jobs) != expected_count:
        raise ValueError(
            "result_refinement ROI count does not match trusted expected_roi_tile_count: "
            f"expected {expected_count}, got {len(planned_jobs)}"
        )

    generated_directory = Path(generated_directory).resolve()
    generated_directory.mkdir(parents=True, exist_ok=True)
    for job in planned_jobs:
        base_region = job["base_region"]
        content = base.crop((
            base_region["x"],
            base_region["y"],
            base_region["x"] + base_region["width"],
            base_region["y"] + base_region["height"],
        ))
        canvas_size = (job["canvas"]["width"], job["canvas"]["height"])
        reference = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        content_region = job["content_region"]
        reference.paste(content, (content_region["x"], content_region["y"]))
        reference.save(job["reference_path"], format="PNG")

    manifest = {
        "version": 2,
        "generated_input_kind": "result_refinement_roi_manifest",
        "execution_route": "result_refinement",
        "base_png_dimensions": {"width": base.width, "height": base.height},
        "operation": operation,
        "roi_jobs": planned_jobs,
    }
    manifest_path = contained_child(
        generated_directory,
        f"{safe_layer_id(layer_id)}-imagegen-manifest.json",
    )
    _atomic_json(manifest_path, manifest)
    return manifest_path, manifest


def antialiased_polygon_mask(size, points, scale=4):
    large = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    draw = ImageDraw.Draw(large)
    draw.polygon([(round(x * scale), round(y * scale)) for x, y in points], fill=255)
    return large.resize(size, Image.Resampling.LANCZOS)


def crop_native_candidate(candidate, roi_job):
    canvas = roi_job["canvas"]
    canvas_size = (canvas["width"], canvas["height"])
    if candidate.size != canvas_size:
        raise ValueError("candidate must preserve the prepared standard canvas")
    region = roi_job["content_region"]
    return candidate.crop((
        region["x"],
        region["y"],
        region["x"] + region["width"],
        region["y"] + region["height"],
    ))


def validate_candidate_bindings(manifest, bindings):
    expected = {job["roi_id"] for job in manifest["roi_jobs"]}
    supplied = set(bindings)
    if supplied != expected:
        missing = sorted(expected - supplied)
        unknown = sorted(supplied - expected)
        raise ValueError(f"candidate bindings mismatch: missing={missing}, unknown={unknown}")


def assert_unapproved_pixels_locked(base, result, approved_mask):
    if result.size != base.size or approved_mask.size != base.size:
        raise ValueError("pixel lock images must have identical dimensions")
    base_bytes = base.convert("RGBA").tobytes()
    result_bytes = result.convert("RGBA").tobytes()
    mask_bytes = approved_mask.convert("L").tobytes()
    for index, approved in enumerate(mask_bytes):
        if approved == 0:
            offset = index * 4
            if base_bytes[offset:offset + 4] != result_bytes[offset:offset + 4]:
                raise ValueError("unapproved RGBA pixels changed")


def _shift_comparison(rgb, distance, axis):
    if axis == "x":
        if rgb.width <= distance:
            return None
        first = rgb.crop((0, 0, rgb.width - distance, rgb.height))
        second = rgb.crop((distance, 0, rgb.width, rgb.height))
    else:
        if rgb.height <= distance:
            return None
        first = rgb.crop((0, 0, rgb.width, rgb.height - distance))
        second = rgb.crop((0, distance, rgb.width, rgb.height))
    difference = ImageChops.difference(first, second)
    return sum(ImageStat.Stat(difference).mean) / (3 * 255)


def checkerboard_score(candidate):
    rgb = candidate.convert("RGB")
    scores = []
    for period in (8, 12, 16, 24, 32):
        adjacent_values = [
            value for value in (
                _shift_comparison(rgb, period, "x"),
                _shift_comparison(rgb, period, "y"),
            ) if value is not None
        ]
        repeated_values = [
            value for value in (
                _shift_comparison(rgb, period * 2, "x"),
                _shift_comparison(rgb, period * 2, "y"),
            ) if value is not None
        ]
        if not adjacent_values or not repeated_values:
            continue
        similarity = 1.0 - (sum(repeated_values) / len(repeated_values))
        contrast = sum(adjacent_values) / len(adjacent_values)
        scores.append((similarity, contrast))
    for similarity, contrast in scores:
        if similarity >= 0.94 and contrast >= 0.45:
            return similarity, contrast
    return max(scores, key=lambda score: score[0] * score[1], default=(0.0, 0.0))


def _validate_candidate_image(candidate, roi_id):
    if not isinstance(candidate, Image.Image):
        raise ValueError(f"candidate for {roi_id} must be a loaded PNG image")
    if candidate.mode not in ("RGB", "RGBA"):
        raise ValueError(f"candidate for {roi_id} must be RGB or RGBA")
    similarity, contrast = checkerboard_score(candidate)
    if similarity >= 0.94 and contrast >= 0.45:
        raise ValueError(f"candidate for {roi_id} contains a baked checkerboard")


def _validate_native_candidate_content(candidate, roi_id):
    similarity, contrast = checkerboard_score(candidate)
    if similarity >= 0.94 and contrast >= 0.45:
        raise ValueError(
            f"candidate for {roi_id} contains a baked checkerboard in native content"
        )


def _integer_geometry(value, label):
    if not isinstance(value, Mapping):
        raise ValueError(f"result_refinement manifest {label} is invalid")
    geometry = {}
    for key in ("x", "y", "width", "height"):
        field = value.get(key)
        if not isinstance(field, int) or isinstance(field, bool):
            raise ValueError(f"result_refinement manifest {label} is invalid")
        geometry[key] = field
    if geometry["x"] < 0 or geometry["y"] < 0 or geometry["width"] <= 0 or geometry["height"] <= 0:
        raise ValueError(f"result_refinement manifest {label} is invalid")
    return geometry


def _annotation_masks(annotations, image_size):
    if not isinstance(annotations, list):
        raise ValueError("result_refinement mask_annotations must be an array")
    masks = {}
    roles = {}
    for annotation in annotations:
        path_id = safe_layer_id(annotation.get("id"))
        if path_id in masks:
            raise ValueError(f"duplicate result_refinement path id: {path_id}")
        if annotation.get("shape") != "bezier_path" or annotation.get("closed") is not True:
            raise ValueError("result_refinement annotations must be closed bezier paths")
        polygon = annotation.get("source_polygon_pixels")
        if not isinstance(polygon, list) or len(polygon) < 3:
            raise ValueError("result_refinement annotation polygon must contain at least three points")
        points = []
        for point in polygon:
            try:
                x, y = _point_coordinates(point)
            except (KeyError, TypeError, IndexError):
                raise ValueError("result_refinement annotation polygon contains an invalid point") from None
            if (
                not isinstance(x, (int, float))
                or isinstance(x, bool)
                or not isinstance(y, (int, float))
                or isinstance(y, bool)
                or not math.isfinite(x)
                or not math.isfinite(y)
                or x < 0
                or y < 0
                or x > image_size[0]
                or y > image_size[1]
            ):
                raise ValueError("result_refinement annotation polygon is outside the base PNG")
            points.append((x, y))
        role = annotation.get("operation_role")
        if role is None:
            kind = annotation.get("kind")
            if kind in ("background", "exclude", "erase"):
                role = "erase"
            elif kind in ("foreground", "keep"):
                role = "protect"
            elif kind == "boundary":
                role = "repair"
        if role not in ("repair", "erase", "protect", "subject"):
            raise ValueError(f"result_refinement annotation role is invalid: {path_id}")
        masks[path_id] = antialiased_polygon_mask(image_size, points)
        roles[path_id] = role
    return masks, roles


def validate_result_refinement_manifest(manifest, base_size, annotations):
    if not isinstance(manifest, Mapping):
        raise ValueError("result_refinement manifest must be an object")
    if manifest.get("version") != 2:
        raise ValueError("result_refinement requires manifest version 2")
    if manifest.get("generated_input_kind") != "result_refinement_roi_manifest":
        raise ValueError("result_refinement manifest kind is invalid")
    if manifest.get("execution_route") != "result_refinement":
        raise ValueError("result_refinement manifest execution route is invalid")
    dimensions = manifest.get("base_png_dimensions") or {}
    if (dimensions.get("width"), dimensions.get("height")) != base_size:
        raise ValueError("result_refinement manifest base dimensions do not match the base PNG")
    operation = manifest.get("operation")
    if not isinstance(operation, Mapping) or operation.get("mode") not in (
        "path_scoped", "keep_inside_delete_outside", "full_canvas_explicit",
    ):
        raise ValueError("result_refinement manifest operation is invalid")
    masks, roles = _annotation_masks(annotations, base_size)
    subject_ids = operation.get("subject_path_ids") or []
    alpha_include_ids = operation.get("alpha_include_path_ids") or []
    if not isinstance(subject_ids, list) or not isinstance(alpha_include_ids, list):
        raise ValueError("result_refinement manifest path ids must be arrays")
    for path_id in subject_ids:
        if roles.get(path_id) != "subject":
            raise ValueError(f"result_refinement subject path is invalid: {path_id}")
    for path_id in alpha_include_ids:
        if roles.get(path_id) != "repair":
            raise ValueError(f"result_refinement alpha inclusion path is invalid: {path_id}")
    if operation.get("mode") == "keep_inside_delete_outside" and not subject_ids:
        raise ValueError("outside-delete requires at least one subject path")

    jobs = manifest.get("roi_jobs")
    if not isinstance(jobs, list):
        raise ValueError("result_refinement manifest roi_jobs must be an array")
    roi_ids = set()
    coverage_by_path = {}
    for job in jobs:
        if not isinstance(job, Mapping):
            raise ValueError("result_refinement manifest ROI job is invalid")
        roi_id = safe_layer_id(job.get("roi_id"))
        if roi_id in roi_ids:
            raise ValueError(f"duplicate result_refinement ROI id: {roi_id}")
        roi_ids.add(roi_id)
        path_id = safe_layer_id(job.get("path_id"))
        if path_id != "full-canvas" and roles.get(path_id) != "repair":
            raise ValueError(f"result_refinement ROI repair path is invalid: {path_id}")
        if path_id == "full-canvas" and operation.get("mode") != "full_canvas_explicit":
            raise ValueError("full-canvas ROI requires full_canvas_explicit mode")
        base_region = _integer_geometry(job.get("base_region"), "base region")
        if base_region["x"] + base_region["width"] > base_size[0] or base_region["y"] + base_region["height"] > base_size[1]:
            raise ValueError("result_refinement manifest base region exceeds the base PNG")
        canvas = job.get("canvas")
        if not isinstance(canvas, Mapping):
            raise ValueError("result_refinement manifest canvas is invalid")
        canvas_size = (canvas.get("width"), canvas.get("height"))
        if canvas_size not in (LANDSCAPE_CANVAS, PORTRAIT_CANVAS, SQUARE_CANVAS):
            raise ValueError("result_refinement manifest canvas is not a standard canvas")
        content_region = _integer_geometry(job.get("content_region"), "content region")
        if (content_region["width"], content_region["height"]) != (base_region["width"], base_region["height"]):
            raise ValueError("result_refinement manifest content region must preserve native pixels")
        if content_region != place_native_region(
            (base_region["width"], base_region["height"]),
            canvas_size,
        ):
            raise ValueError("result_refinement manifest content region is inconsistent with the canvas")
        coverage = coverage_by_path.setdefault(path_id, Image.new("L", base_size, 0))
        ImageDraw.Draw(coverage).rectangle((
            base_region["x"],
            base_region["y"],
            base_region["x"] + base_region["width"] - 1,
            base_region["y"] + base_region["height"] - 1,
        ), fill=255)
    for path_id, role in roles.items():
        if role != "repair" or operation.get("mode") == "full_canvas_explicit":
            continue
        required = masks[path_id].point(lambda value: 255 if value >= 128 else 0)
        coverage = coverage_by_path.get(path_id, Image.new("L", base_size, 0))
        if ImageChops.subtract(required, coverage).getbbox() is not None:
            raise ValueError(f"result_refinement ROI jobs do not cover repair path: {path_id}")
    if operation.get("mode") == "full_canvas_explicit" and jobs:
        coverage = coverage_by_path.get("full-canvas", Image.new("L", base_size, 0))
        if ImageChops.invert(coverage).getbbox() is not None:
            raise ValueError("result_refinement full-canvas ROI jobs do not cover the base PNG")
    return masks, roles


def assert_canonical_roi_jobs(manifest, annotations, roi_policy, base_size):
    operation = manifest.get("operation") or {}
    actual_jobs = manifest.get("roi_jobs") or []
    regions = []
    if operation.get("mode") == "full_canvas_explicit":
        if actual_jobs:
            regions.append(("full-canvas", {
                "x": 0,
                "y": 0,
                "width": base_size[0],
                "height": base_size[1],
            }))
    else:
        for annotation in annotations:
            if annotation.get("operation_role") != "repair":
                continue
            path_id = safe_layer_id(annotation.get("id"))
            bounds = polygon_bounds(
                annotation.get("source_polygon_pixels") or [],
                base_size,
            )
            regions.append((path_id, padded_region(
                bounds,
                base_size,
                ratio=roi_policy.get("context_padding_ratio", 0.08),
                minimum=roi_policy.get("minimum_padding_ratio", 0.03),
                maximum=roi_policy.get("maximum_padding_ratio", 0.15),
            )))

    expected_jobs = []
    overlap_pixels = roi_policy.get("tile_overlap_pixels", 32)
    for path_id, region in regions:
        canvas_size = choose_native_canvas(region["width"], region["height"])
        for tile_index, tile in enumerate(
            tile_region(region, canvas_size, overlap_pixels),
            start=1,
        ):
            expected_jobs.append({
                "roi_id": f"{path_id}-tile-{tile_index:03d}",
                "path_id": path_id,
                "base_region": tile,
                "canvas": {"width": canvas_size[0], "height": canvas_size[1]},
                "content_region": place_native_region(
                    (tile["width"], tile["height"]),
                    canvas_size,
                ),
            })

    actual_geometry = [{
        key: job.get(key)
        for key in ("roi_id", "path_id", "base_region", "canvas", "content_region")
    } for job in actual_jobs if isinstance(job, Mapping)]
    if actual_geometry != expected_jobs or len(actual_geometry) != len(actual_jobs):
        raise ValueError("result_refinement manifest does not contain canonical native ROI jobs")


def _union_masks(size, masks):
    combined = Image.new("L", size, 0)
    for mask in masks:
        combined = ImageChops.lighter(combined, mask)
    return combined


def _stable_coverage(mask):
    return mask.point(lambda value: 0 if value <= 1 else 255 if value >= 254 else value)


def _intersection(first, second):
    left = max(first["x"], second["x"])
    top = max(first["y"], second["y"])
    right = min(first["x"] + first["width"], second["x"] + second["width"])
    bottom = min(first["y"] + first["height"], second["y"] + second["height"])
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _tile_overlap_feather(current_job, previous_job):
    current = current_job["base_region"]
    previous = previous_job["base_region"]
    feather = Image.new("L", (current["width"], current["height"]), 255)
    overlap = _intersection(current, previous)
    if overlap is None:
        return feather
    left, top, right, bottom = overlap
    local_left = left - current["x"]
    local_top = top - current["y"]
    overlap_width = right - left
    overlap_height = bottom - top
    draw = ImageDraw.Draw(feather)

    if current["y"] != previous["y"]:
        ascending = current["y"] > previous["y"]
        for offset in range(overlap_height):
            progress = 0.5 if overlap_height == 1 else offset / (overlap_height - 1)
            if not ascending:
                progress = 1 - progress
            value = round(progress * 255)
            y = local_top + offset
            draw.line((local_left, y, local_left + overlap_width - 1, y), fill=value)
    elif current["x"] != previous["x"]:
        ascending = current["x"] > previous["x"]
        for offset in range(overlap_width):
            progress = 0.5 if overlap_width == 1 else offset / (overlap_width - 1)
            if not ascending:
                progress = 1 - progress
            value = round(progress * 255)
            x = local_left + offset
            draw.line((x, local_top, x, local_top + overlap_height - 1), fill=value)
    else:
        draw.rectangle((
            local_left,
            local_top,
            local_left + overlap_width - 1,
            local_top + overlap_height - 1,
        ), fill=128)
    return feather


def compose_result_refinement(base, annotations, manifest, bindings):
    base_rgba = base.convert("RGBA")
    masks, roles = validate_result_refinement_manifest(manifest, base_rgba.size, annotations)
    if not isinstance(bindings, Mapping):
        raise ValueError("result_refinement candidate bindings must be a mapping")
    validate_candidate_bindings(manifest, bindings)

    result_rgb = base_rgba.convert("RGB")
    approved_mask = Image.new("L", base_rgba.size, 0)
    previous_tiles = []
    for job in manifest["roi_jobs"]:
        roi_id = job["roi_id"]
        candidate = bindings[roi_id]
        _validate_candidate_image(candidate, roi_id)
        native_content = crop_native_candidate(candidate, job)
        _validate_native_candidate_content(native_content, roi_id)
        native = native_content.convert("RGB")
        base_region = job["base_region"]
        if native.size != (base_region["width"], base_region["height"]):
            raise ValueError("candidate content region must preserve native ROI dimensions")
        if job["path_id"] == "full-canvas":
            edit_mask = Image.new("L", base_rgba.size, 255)
        else:
            edit_mask = _stable_coverage(masks[job["path_id"]])
        tile_mask = edit_mask.crop((
            base_region["x"],
            base_region["y"],
            base_region["x"] + base_region["width"],
            base_region["y"] + base_region["height"],
        ))
        blend_weight = Image.new("L", native.size, 255)
        for previous_job, previous_authority in previous_tiles:
            previous_overlap = previous_authority.crop((
                base_region["x"],
                base_region["y"],
                base_region["x"] + base_region["width"],
                base_region["y"] + base_region["height"],
            ))
            overlap_authority = ImageChops.darker(tile_mask, previous_overlap)
            if overlap_authority.getbbox() is None:
                continue
            feather = _tile_overlap_feather(job, previous_job)
            constrained = Image.new("L", native.size, 255)
            constrained.paste(feather, mask=overlap_authority)
            blend_weight = ImageChops.darker(blend_weight, constrained)
        effective_mask = ImageChops.multiply(tile_mask, blend_weight)
        result_rgb.paste(native, (base_region["x"], base_region["y"]), effective_mask)
        tile_authority = Image.new("L", base_rgba.size, 0)
        tile_authority.paste(tile_mask, (base_region["x"], base_region["y"]))
        approved_mask = ImageChops.lighter(approved_mask, tile_authority)
        previous_tiles.append((job, tile_authority))

    result = Image.merge("RGBA", (*result_rgb.split(), base_rgba.getchannel("A")))
    alpha = result.getchannel("A")
    operation = manifest["operation"]
    for path_id in operation.get("alpha_include_path_ids") or []:
        include_mask = _stable_coverage(masks[path_id])
        alpha = ImageChops.lighter(alpha, include_mask)
        approved_mask = ImageChops.lighter(approved_mask, include_mask)

    erase_masks = [
        _stable_coverage(masks[path_id])
        for path_id, role in roles.items()
        if role == "erase"
    ]
    for erase_mask in erase_masks:
        alpha.paste(0, mask=erase_mask)
        approved_mask = ImageChops.lighter(approved_mask, erase_mask)

    if operation.get("mode") == "keep_inside_delete_outside":
        subject_mask = _stable_coverage(_union_masks(
            base_rgba.size,
            [masks[path_id] for path_id in operation.get("subject_path_ids") or []],
        ))
        alpha = ImageChops.multiply(alpha, subject_mask)
        approved_mask = ImageChops.lighter(approved_mask, ImageChops.invert(subject_mask))
    result.putalpha(alpha)

    protect_mask = _stable_coverage(_union_masks(
        base_rgba.size,
        [masks[path_id] for path_id, role in roles.items() if role == "protect"],
    ))
    if protect_mask.getbbox() is not None:
        result.paste(base_rgba, mask=protect_mask)

    assert_unapproved_pixels_locked(base_rgba, result, approved_mask)
    return result
