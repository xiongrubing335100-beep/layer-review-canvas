import json
import math
import os
from collections.abc import Mapping
from pathlib import Path

from PIL import Image

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
