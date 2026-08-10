import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

try:
    from scripts.safe_layer_path import contained_child, safe_layer_id
    from scripts.result_refinement_roi import (
        assert_canonical_roi_jobs,
        compose_result_refinement,
        expected_result_refinement_alpha,
    )
except ModuleNotFoundError:
    from safe_layer_path import contained_child, safe_layer_id
    from result_refinement_roi import (
        assert_canonical_roi_jobs,
        compose_result_refinement,
        expected_result_refinement_alpha,
    )


VALIDATION_KEYS = (
    "count",
    "dimensions",
    "alpha",
    "annotation_conformance",
    "obvious_exclusion",
    "structure_integrity",
)

RESULT_REFINEMENT_VALIDATION_KEYS = (
    "dimensions",
    "alpha",
    "annotation_conformance",
    "outside_pixel_lock",
    "no_baked_checkerboard",
    "structure_integrity",
)

CODEX_RGBA_CATEGORIES = {"kvTitle", "ordinaryText", "logo"}
RMBG_MODEL = "bria-rmbg"
LANDSCAPE_CANVAS = (1536, 1024)
PORTRAIT_CANVAS = (1024, 1536)
SQUARE_CANVAS = (1024, 1024)


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def reserve_versioned_output_path(final_directory, layer_id):
    stem = safe_layer_id(layer_id)
    version = 1
    while True:
        candidate = contained_child(final_directory, f"{stem}-v{version:03d}.png")
        if candidate.exists():
            version += 1
            continue
        reservation = contained_child(final_directory, f".{stem}-v{version:03d}.reserve")
        try:
            descriptor = os.open(reservation, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            version += 1
            continue
        else:
            os.close(descriptor)
            if candidate.exists():
                reservation.unlink(missing_ok=True)
                version += 1
                continue
            return candidate, reservation


def parse_result_refinement_bindings(values):
    if values is None:
        return {}
    if isinstance(values, dict):
        parsed = {}
        items = values.items()
    else:
        if isinstance(values, (str, os.PathLike)):
            values = [values]
        parsed = {}
        items = []
        for value in values:
            text = os.fspath(value)
            roi_id, separator, candidate_path = text.partition("=")
            if not separator or not roi_id or not candidate_path:
                raise ValueError(
                    "result_refinement --generated-input must be roi-id=/absolute/path.png"
                )
            items.append((roi_id, candidate_path))
    for roi_id, candidate_path in items:
        roi_id = safe_layer_id(roi_id)
        if roi_id in parsed:
            raise ValueError(f"duplicate result_refinement candidate binding: {roi_id}")
        candidate_path = Path(candidate_path)
        if not candidate_path.is_absolute():
            raise ValueError("result_refinement candidate binding path must be absolute")
        parsed[roi_id] = candidate_path
    return parsed


def load_result_refinement_manifest(
    mapping_path,
    generated_root,
    base_image,
    layer,
    *,
    trusted_layer=None,
):
    base_rgba = base_image.convert("RGBA")
    base_size = base_rgba.size
    if mapping_path is None:
        raise ValueError("result_refinement requires --imagegen-mapping")
    resolved = Path(mapping_path).resolve()
    if not contained(resolved, generated_root):
        raise ValueError("result_refinement manifest must be inside the job generated directory")
    if not resolved.is_file():
        raise ValueError("result_refinement manifest does not exist")
    manifest = json.loads(resolved.read_text(encoding="utf-8"))
    if manifest.get("version") != 2:
        raise ValueError("result_refinement requires manifest version 2")
    if manifest.get("generated_input_kind") != "result_refinement_roi_manifest":
        raise ValueError("result_refinement manifest kind is invalid")
    if manifest.get("execution_route") != "result_refinement":
        raise ValueError("result_refinement manifest execution route is invalid")
    dimensions = manifest.get("base_png_dimensions") or {}
    if (dimensions.get("width"), dimensions.get("height")) != base_size:
        raise ValueError("result_refinement manifest base dimensions do not match the base PNG")
    operation = layer.get("refinement_operation") or {}
    if manifest.get("operation") != {
        "mode": operation.get("mode"),
        "subject_path_ids": list(operation.get("subject_path_ids") or []),
        "alpha_include_path_ids": list(operation.get("alpha_include_path_ids") or []),
    }:
        raise ValueError("result_refinement manifest operation does not match the plan")
    jobs = manifest.get("roi_jobs")
    policy_layer = trusted_layer or layer
    expected_count = policy_layer.get("expected_roi_tile_count")
    if not isinstance(jobs, list) or not isinstance(expected_count, int) or isinstance(expected_count, bool):
        raise ValueError("result_refinement ROI count is invalid")
    if len(jobs) != expected_count:
        raise ValueError(
            "result_refinement ROI count does not match the plan: "
            f"expected {expected_count}, got {len(jobs)}"
        )
    budget = policy_layer.get("maximum_imagegen_calls")
    if (
        not isinstance(budget, int)
        or isinstance(budget, bool)
        or budget != len(jobs) * 2
    ):
        raise ValueError(
            "result_refinement ImageGen call budget must be exactly twice the ROI count"
        )
    assert_canonical_roi_jobs(
        manifest,
        layer.get("mask_annotations") or [],
        layer.get("roi_policy") or {},
        base_size,
    )
    for job in jobs:
        reference_path = Path(job.get("reference_path", "")).resolve()
        if not contained(reference_path, generated_root) or not reference_path.is_file():
            raise ValueError("result_refinement manifest reference path is invalid")
        canvas = job.get("canvas") or {}
        expected_canvas = (canvas.get("width"), canvas.get("height"))
        base_region = job["base_region"]
        content_region = job["content_region"]
        expected_reference = Image.new("RGBA", expected_canvas, (0, 0, 0, 0))
        expected_reference.paste(
            base_rgba.crop((
                base_region["x"],
                base_region["y"],
                base_region["x"] + base_region["width"],
                base_region["y"] + base_region["height"],
            )),
            (content_region["x"], content_region["y"]),
        )
        with Image.open(reference_path) as reference:
            if (
                reference.format != "PNG"
                or reference.mode != "RGBA"
                or reference.size != expected_canvas
            ):
                raise ValueError(
                    "result_refinement manifest reference does not match its canvas"
                )
            if reference.tobytes() != expected_reference.tobytes():
                raise ValueError(
                    "result_refinement manifest reference pixels do not match the base ROI "
                    "and transparent padding"
                )
    return manifest


def load_plan(job_directory):
    return json.loads((job_directory / "layer-review-plan.json").read_text(encoding="utf-8"))


def load_trusted_preflight_layer(job_directory, layer_id):
    preflight_path = job_directory / "preflight.json"
    if not preflight_path.is_file():
        return None
    preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
    if preflight.get("job_id") != job_directory.name:
        raise ValueError("preflight job does not match jobId")
    return find_layer(preflight, layer_id)


def find_layer(plan, layer_id):
    for layer in plan.get("layers", []):
        if str(layer.get("id")) == str(layer_id):
            return layer
    raise ValueError(f"layer not found: {layer_id}")


def expected_output(layer):
    output = layer.get("expected_output") or layer.get("output") or {}
    width = int(output.get("width", 0))
    height = int(output.get("height", 0))
    x = int(output.get("original_source_x", layer.get("source_region_pixels", {}).get("x", 0)))
    y = int(output.get("original_source_y", layer.get("source_region_pixels", {}).get("y", 0)))
    if width <= 0 or height <= 0 or x < 0 or y < 0:
        raise ValueError("expected output dimensions are invalid")
    return width, height, x, y


def contained(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def validate_repair_regions(layer, width, height):
    regions = layer.get("repair_regions")
    if regions is None:
        return None
    if layer.get("repair_region_source") not in ("submitted_annotation", "codex_declared"):
        raise ValueError("repair_regions require an allowed repair_region_source")
    for region in regions:
        rx = int(region.get("x", -1))
        ry = int(region.get("y", -1))
        rw = int(region.get("width", 0))
        rh = int(region.get("height", 0))
        if rx < 0 or ry < 0 or rw <= 0 or rh <= 0 or rx + rw > width or ry + rh > height:
            raise ValueError("repair region is outside the selected output canvas")
    return regions


def apply_source_pixel_lock(candidate, source, width, height, source_x, source_y, regions):
    if not regions:
        return candidate
    source_crop = source.crop((source_x, source_y, source_x + width, source_y + height)).convert("RGBA")
    target_width, target_height = candidate.size
    if source_crop.size != candidate.size:
        source_crop = source_crop.resize(candidate.size, Image.Resampling.LANCZOS)
    locked = candidate.copy()
    repair_mask = Image.new("1", candidate.size, 0)
    scale_x = target_width / width
    scale_y = target_height / height
    for region in regions:
        left = round(int(region["x"]) * scale_x)
        top = round(int(region["y"]) * scale_y)
        right = round((int(region["x"]) + int(region["width"])) * scale_x)
        bottom = round((int(region["y"]) + int(region["height"])) * scale_y)
        repair_mask.paste(1, (
            left,
            top,
            right,
            bottom,
        ))
    locked.paste(source_crop, mask=Image.eval(repair_mask, lambda value: 1 - value))
    return locked


def run_rmbg(input_path, output_path, width, height, rmbg_script):
    subprocess.run([
        sys.executable,
        str(rmbg_script),
        "--input", str(input_path),
        "--output", str(output_path),
        "--model", RMBG_MODEL,
        "--expected-width", str(width),
        "--expected-height", str(height),
    ], check=True, capture_output=True, text=True)


def resolve_transparency_strategy(layer):
    explicit = layer.get("transparency_strategy")
    if explicit in ("none", "codex_rgba", "rembg", "preserve_existing_alpha"):
        return explicit
    processor = layer.get("remove_background_processor") or {}
    if processor.get("engine") == "codex_rgba":
        return "codex_rgba"
    if processor.get("engine") == "rembg" or layer.get("rmbg_required") is True:
        return "rembg"
    if not layer.get("remove_background"):
        return "none"
    return "codex_rgba" if layer.get("category") in CODEX_RGBA_CATEGORIES else "rembg"


def validate_transparent_structure(rgba, label):
    alpha = rgba.getchannel("A")
    alpha_min, alpha_max = alpha.getextrema()
    if alpha_min != 0 or alpha_max == 0:
        raise ValueError(f"{label} must contain real transparent and visible pixels")
    visible_pixels = sum(1 for value in alpha.get_flattened_data() if value > 8)
    if visible_pixels < max(1, rgba.width * rgba.height // 200):
        raise ValueError(f"{label} contains only transparent residue")


def validate_source_rgb_fidelity(candidate, source_crop):
    compared = 0
    preserved = 0
    for candidate_pixel, source_pixel in zip(
        candidate.get_flattened_data(),
        source_crop.get_flattened_data(),
    ):
        if candidate_pixel[3] <= 8:
            continue
        compared += 1
        if max(abs(candidate_pixel[index] - source_pixel[index]) for index in range(3)) <= 16:
            preserved += 1
    if compared == 0 or preserved / compared < 0.9:
        raise ValueError("Codex RGBA changed reliable source glyph colors or material")


def validate_result_refinement_structure(candidate, base, *, annotations, operation):
    expected_alpha = expected_result_refinement_alpha(base, annotations, operation)
    if candidate.getchannel("A").tobytes() != expected_alpha.tobytes():
        raise ValueError("result_refinement output contains unauthorized Alpha changes")


def canonical_imagegen_geometry(width, height):
    ratio = width / height
    if ratio > 1.2:
        canvas_width, canvas_height = LANDSCAPE_CANVAS
    elif ratio < 1 / 1.2:
        canvas_width, canvas_height = PORTRAIT_CANVAS
    else:
        canvas_width, canvas_height = SQUARE_CANVAS
    scale = min(canvas_width / width, canvas_height / height)
    region_width = max(1, round(width * scale))
    region_height = max(1, round(height * scale))
    return {
        "canvas": {"width": canvas_width, "height": canvas_height},
        "content_region": {
            "x": (canvas_width - region_width) // 2,
            "y": (canvas_height - region_height) // 2,
            "width": region_width,
            "height": region_height,
        },
    }


def load_imagegen_mapping(mapping_path, generated_root, job_id, layer_id, width, height):
    resolved = Path(mapping_path).resolve()
    if not contained(resolved, generated_root):
        raise ValueError("ImageGen mapping must be inside the job generated directory")
    if not resolved.is_file():
        raise ValueError("ImageGen mapping does not exist")
    mapping = json.loads(resolved.read_text(encoding="utf-8"))
    if mapping.get("job_id") != job_id or str(mapping.get("layer_id")) != str(layer_id):
        raise ValueError("ImageGen mapping does not match the current job and layer")
    mapping_kind = mapping.get("generated_input_kind")
    if mapping_kind not in (
        "codex_alpha_matte",
        "targeted_repair_canvas",
        "result_refinement_canvas",
    ):
        raise ValueError("unsupported ImageGen mapping kind")
    expected = mapping.get("expected_output") or {}
    if (int(expected.get("width", 0)), int(expected.get("height", 0))) != (width, height):
        raise ValueError("ImageGen mapping expected output does not match the plan")
    if mapping_kind in ("targeted_repair_canvas", "result_refinement_canvas"):
        expected_route = (
            "targeted_repair"
            if mapping_kind == "targeted_repair_canvas"
            else "result_refinement"
        )
        if mapping.get("execution_route") != expected_route:
            raise ValueError(f"{expected_route} mapping execution route does not match the plan")
        canonical = canonical_imagegen_geometry(width, height)
        if mapping.get("canvas") != canonical["canvas"] or mapping.get("content_region") != canonical["content_region"]:
            raise ValueError(f"{expected_route} mapping does not match canonical canvas geometry")
    if mapping_kind == "result_refinement_canvas":
        base_dimensions = mapping.get("base_png_dimensions") or {}
        if (
            int(base_dimensions.get("width", 0)),
            int(base_dimensions.get("height", 0)),
        ) != (width, height):
            raise ValueError("result_refinement mapping base dimensions do not match the base PNG")
    return mapping


def crop_mapped_imagegen_canvas(
    candidate,
    mapping,
    width,
    height,
    label,
    preserve_content_resolution=False,
    allow_uniformly_scaled_canvas=False,
):
    canvas = mapping.get("canvas") or {}
    canvas_size = (int(canvas.get("width", 0)), int(canvas.get("height", 0)))
    candidate_size = candidate.size
    if candidate_size != canvas_size and not allow_uniformly_scaled_canvas:
        raise ValueError(
            f"{label} must preserve the prepared {canvas_size[0]}x{canvas_size[1]} canvas"
        )
    if candidate_size != canvas_size and (
        candidate_size[0] * canvas_size[1] != candidate_size[1] * canvas_size[0]
    ):
        raise ValueError(
            f"{label} native canvas aspect ratio must match the prepared canvas"
        )

    region = mapping.get("content_region") or {}
    x = int(region.get("x", -1))
    y = int(region.get("y", -1))
    region_width = int(region.get("width", 0))
    region_height = int(region.get("height", 0))
    if (
        x < 0 or y < 0 or region_width <= 0 or region_height <= 0
        or x + region_width > canvas_size[0]
        or y + region_height > canvas_size[1]
    ):
        raise ValueError("ImageGen content region is invalid")

    scale_x = candidate_size[0] / canvas_size[0]
    scale_y = candidate_size[1] / canvas_size[1]
    mapped_left = round(x * scale_x)
    mapped_top = round(y * scale_y)
    mapped_right = round((x + region_width) * scale_x)
    mapped_bottom = round((y + region_height) * scale_y)
    content = candidate.crop((mapped_left, mapped_top, mapped_right, mapped_bottom))
    if not preserve_content_resolution and content.size != (width, height):
        content = content.resize((width, height), Image.Resampling.LANCZOS)
    return content


def compose_source_locked_matte(candidate, source_crop, mapping, width, height):
    content = crop_mapped_imagegen_canvas(
        candidate,
        mapping,
        width,
        height,
        "ImageGen matte",
    )
    alpha = content.convert("L")
    alpha_min, alpha_max = alpha.getextrema()
    if alpha_min > 16 or alpha_max < 239:
        raise ValueError("ImageGen matte must contain a black background and white subject")

    source_locked = source_crop.copy()
    source_locked.putalpha(alpha)
    validate_transparent_structure(source_locked, "Codex alpha matte")
    return source_locked


def validate_png(path, width, height, require_alpha):
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        if rgba.size != (width, height):
            raise ValueError(f"final PNG dimensions must be {width}x{height}")
        alpha_min, alpha_max = rgba.getchannel("A").getextrema()
        if require_alpha and (alpha_min != 0 or alpha_max == 0):
            raise ValueError("RMBG output does not contain usable transparent pixels")
        return rgba


def finalize_job(
    job_id,
    layer_id,
    generated_input,
    *,
    jobs_root,
    rmbg_script,
    imagegen_mapping=None,
    clock=now_iso,
    rmbg_runner=run_rmbg,
    asset_publisher=os.replace,
    completed_report_writer=atomic_json,
):
    requested_layer_id = layer_id
    started = clock()
    job_directory = None
    report_path = None
    plan = {}
    layer = None
    route = None
    final_path = None
    reservation_path = None
    temporary_directory = None
    try:
        job_directory = (jobs_root / job_id).resolve()
        if job_directory.name != job_id:
            raise ValueError("job directory does not match jobId")
        if job_directory.is_dir():
            report_path = contained_child(job_directory, "execution-report.json")
        layer_id = safe_layer_id(layer_id)
        plan = load_plan(job_directory)
        layer = find_layer(plan, layer_id)
        route = layer.get("execution_route_hint")
        width, height, source_x, source_y = expected_output(layer)
        generated_root = contained_child(job_directory, "generated")
        generated_path = None
        if route != "result_refinement":
            if generated_input is None:
                generated_input = []
            if isinstance(generated_input, (list, tuple)):
                if len(generated_input) != 1:
                    raise ValueError("non-refinement routes require exactly one --generated-input")
                generated_input = generated_input[0]
            generated_path = Path(generated_input).resolve()
            if not contained(generated_path, generated_root):
                raise ValueError("ImageGen input must be inside the job generated directory")
            if not generated_path.is_file():
                raise ValueError("ImageGen input does not exist")

        final_directory = contained_child(job_directory, "final")
        planned_output = Path(plan.get("output_directory", final_directory)).resolve()
        if planned_output != final_directory:
            raise ValueError("planned output directory must be the current job final directory")
        final_directory.mkdir(parents=True, exist_ok=True)
        output_layer_id = safe_layer_id(layer.get("id") or layer_id)
        final_path = (
            None
            if route == "result_refinement"
            else contained_child(final_directory, f"{output_layer_id}.png")
        )
        temporary_directory = Path(tempfile.mkdtemp(
            prefix="targeted-finalize-",
            dir=generated_root,
        ))
        temporary_candidate = temporary_directory / "candidate.png"
        temporary_output = temporary_directory / "output.png"
        base_image = None
        image_width, image_height = width, height
        if route == "result_refinement":
            source_path = Path(plan.get("source", {}).get("local_path", "")).resolve()
            if not source_path.is_file():
                raise ValueError("result_refinement base PNG does not exist")
            with Image.open(source_path) as source:
                if source.format != "PNG":
                    raise ValueError("result_refinement base must be a PNG")
                base_image = source.convert("RGBA")
            image_width, image_height = base_image.size

        transparency = resolve_transparency_strategy(layer)
        output_resolution_policy = layer.get("output_resolution_policy") or (
            "native_imagegen_content"
            if route == "targeted_repair" and transparency == "rembg"
            else "logical_crop"
        )
        if route == "result_refinement":
            output_resolution_policy = "existing_result_pixels"
            if transparency != "preserve_existing_alpha":
                raise ValueError("result_refinement requires preserve_existing_alpha")
            if layer.get("rmbg_required") is not False:
                raise ValueError("result_refinement forbids RMBG")
        if route in ("targeted_repair", "result_refinement") and imagegen_mapping is None:
            raise ValueError(f"{route} requires --imagegen-mapping")
        annotations = layer.get("mask_annotations") or []
        mapping = None
        if route == "result_refinement":
            trusted_layer = load_trusted_preflight_layer(job_directory, layer_id)
            mapping = load_result_refinement_manifest(
                imagegen_mapping,
                generated_root,
                base_image,
                layer,
                trusted_layer=trusted_layer,
            )
            binding_paths = parse_result_refinement_bindings(generated_input)
            loaded_candidates = {}
            for roi_id, candidate_path in binding_paths.items():
                resolved_candidate = candidate_path.resolve()
                if not contained(resolved_candidate, generated_root):
                    raise ValueError(
                        "result_refinement candidate must be inside the job generated directory"
                    )
                if not resolved_candidate.is_file():
                    raise ValueError(f"result_refinement candidate does not exist: {roi_id}")
                with Image.open(resolved_candidate) as image:
                    if image.format != "PNG" or image.mode not in ("RGB", "RGBA"):
                        raise ValueError(
                            f"result_refinement candidate for {roi_id} must be an RGB or RGBA PNG"
                        )
                    loaded_candidates[roi_id] = image.copy()
            candidate = compose_result_refinement(
                base_image,
                annotations,
                mapping,
                loaded_candidates,
            )
            regions = None
        else:
            with Image.open(generated_path) as image:
                candidate = image.convert("RGBA")

        if route != "result_refinement" and imagegen_mapping is not None:
            mapping = load_imagegen_mapping(
                imagegen_mapping,
                generated_root,
                job_id,
                layer.get("id") or layer_id,
                image_width,
                image_height,
            )
            mapping_kind = mapping.get("generated_input_kind")
            if transparency == "codex_rgba":
                if mapping_kind != "codex_alpha_matte":
                    raise ValueError("Codex RGBA requires a codex_alpha_matte mapping")
            elif route == "targeted_repair":
                if mapping_kind != "targeted_repair_canvas":
                    raise ValueError("targeted_repair requires a targeted_repair_canvas mapping")
                preserve_native_rmbg = output_resolution_policy == "native_imagegen_content"
                candidate = crop_mapped_imagegen_canvas(
                    candidate,
                    mapping,
                    width,
                    height,
                    "ImageGen targeted repair",
                    preserve_content_resolution=preserve_native_rmbg,
                    allow_uniformly_scaled_canvas=preserve_native_rmbg,
                )
            else:
                raise ValueError("ImageGen mapping is only valid for codex_rgba or targeted_repair")
        elif route != "result_refinement" and candidate.size != (width, height):
            raise ValueError(f"ImageGen input must already be {width}x{height}")
        if route != "result_refinement":
            regions = validate_repair_regions(layer, width, height)
        if route != "result_refinement" and regions:
            source_path = Path(plan.get("source", {}).get("local_path", ""))
            if not source_path.is_file():
                raise ValueError("source image is required for declared repair regions")
            with Image.open(source_path) as source:
                candidate = apply_source_pixel_lock(candidate, source.convert("RGBA"), width, height, source_x, source_y, regions)

        remove_background = bool(layer.get("remove_background"))
        if transparency == "codex_rgba":
            if not remove_background:
                raise ValueError("Codex RGBA strategy requires remove_background")
            if layer.get("rmbg_required") is True:
                raise ValueError("Codex RGBA strategy cannot require RMBG")
            source_path = Path(plan.get("source", {}).get("local_path", ""))
            if not source_path.is_file():
                raise ValueError("source image is required for Codex RGBA validation")
            with Image.open(source_path) as source:
                source_crop = source.convert("RGBA").crop((
                    source_x,
                    source_y,
                    source_x + width,
                    source_y + height,
                ))
            if mapping is not None:
                candidate = compose_source_locked_matte(candidate, source_crop, mapping, width, height)
            validate_transparent_structure(candidate, "Codex RGBA output")
            validate_source_rgb_fidelity(candidate, source_crop)
        candidate.save(temporary_candidate, format="PNG")
        asset_width, asset_height = candidate.size

        rmbg_required = transparency == "rembg"
        rmbg_started = None
        rmbg_completed = None
        if rmbg_required:
            rmbg_started = clock()
            rmbg_runner(
                temporary_candidate,
                temporary_output,
                asset_width,
                asset_height,
                rmbg_script,
            )
            rmbg_completed = clock()
            validation_started = clock()
            final_image = validate_png(temporary_output, asset_width, asset_height, True)
        else:
            validation_started = clock()
            final_image = validate_png(
                temporary_candidate,
                asset_width,
                asset_height,
                remove_background,
            )
        if route == "result_refinement":
            if final_image.mode != "RGBA" or final_image.size != base_image.size:
                raise ValueError("result_refinement output must be RGBA at the base PNG dimensions")
            validate_result_refinement_structure(
                final_image,
                base_image,
                annotations=annotations,
                operation=mapping["operation"],
            )
        if remove_background:
            validate_transparent_structure(final_image, "final PNG")
        final_image.save(temporary_output, format="PNG")
        if route == "result_refinement":
            final_path, reservation_path = reserve_versioned_output_path(
                final_directory,
                output_layer_id,
            )
        asset_publisher(temporary_output, final_path)
        completed = clock()
        logical_placement = (
            dict(layer.get("placement"))
            if route == "result_refinement" and isinstance(layer.get("placement"), dict)
            else {
                "x": source_x,
                "y": source_y,
                "width": width,
                "height": height,
            }
        )
        report = {
            "status": "completed",
            "execution_route": layer.get("execution_route_hint"),
            "layer_id": layer.get("id") or layer_id,
            "output": str(final_path),
            "output_path": str(final_path),
            "output_resolution_policy": output_resolution_policy,
            "asset_dimensions": {"width": asset_width, "height": asset_height},
            "logical_placement": logical_placement,
            "timing": {
                **(plan.get("execution_timing") or {}),
                "postprocess_started_at": started,
                **({"rmbg_started_at": rmbg_started} if rmbg_started else {}),
                **({"rmbg_completed_at": rmbg_completed} if rmbg_completed else {}),
                "validation_started_at": validation_started,
                "completed_at": completed,
            },
            "validation_results": {
                key: True
                for key in (
                    RESULT_REFINEMENT_VALIDATION_KEYS
                    if route == "result_refinement"
                    else VALIDATION_KEYS
                )
            },
            "rmbg": {
                "required": rmbg_required,
                "model": RMBG_MODEL if rmbg_required else None,
            },
            "transparency": {
                "strategy": transparency,
                "structure_validation": (
                    "source_rgb_and_alpha"
                    if transparency == "codex_rgba"
                    else "base_rgba_pixel_lock"
                    if transparency == "preserve_existing_alpha"
                    else "alpha"
                ),
                "generated_input_kind": mapping.get("generated_input_kind") if mapping else "rgba_candidate",
            },
            **({
                "parent_job_id": plan.get("parent_job_id"),
                "parent_version_id": plan.get("parent_version_id"),
                "input_dimensions": {"width": image_width, "height": image_height},
                "output_dimensions": {"width": asset_width, "height": asset_height},
                "annotation_count": len(annotations),
                "preserve_existing_alpha": True,
                "roi_count": len(mapping["roi_jobs"]),
                "candidate_count": len(binding_paths),
                "imagegen_call_budget": layer.get("maximum_imagegen_calls"),
            } if route == "result_refinement" else {}),
        }
        completed_report_writer(job_directory / "execution-report.json", report)
        if reservation_path is not None:
            reservation_path.unlink()
        return report
    except Exception as error:
        if route == "result_refinement" and final_path is not None:
            final_path.unlink(missing_ok=True)
        if reservation_path is not None:
            reservation_path.unlink(missing_ok=True)
        reported_layer_id = (
            layer.get("id") or layer_id
            if isinstance(layer, dict)
            else requested_layer_id
        )
        report = {
            "status": "failed",
            "execution_route": (
                layer.get("execution_route_hint")
                if isinstance(layer, dict)
                else route
            ),
            "layer_id": reported_layer_id,
            "error": str(error),
            "timing": {"postprocess_started_at": started, "completed_at": clock()},
            "validation_results": {
                key: False
                for key in (
                    RESULT_REFINEMENT_VALIDATION_KEYS
                    if route == "result_refinement"
                    else VALIDATION_KEYS
                )
            },
        }
        if report_path is not None:
            atomic_json(report_path, report)
        raise
    finally:
        if temporary_directory is not None:
            shutil.rmtree(temporary_directory, ignore_errors=True)


def parse_args():
    parser = argparse.ArgumentParser(description="Finalize one targeted ImageGen split result.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--layer-id", required=True)
    parser.add_argument("--generated-input", action="append", default=[])
    parser.add_argument("--imagegen-mapping", type=Path)
    parser.add_argument("--jobs-root", type=Path, default=Path("output") / "jobs")
    parser.add_argument("--rmbg-script", type=Path, default=Path("scripts") / "finalize-rmbg.py")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        result = finalize_job(
            args.job_id,
            args.layer_id,
            args.generated_input,
            jobs_root=args.jobs_root.resolve(),
            rmbg_script=args.rmbg_script.resolve(),
            imagegen_mapping=args.imagegen_mapping.resolve() if args.imagegen_mapping else None,
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(f"Targeted finalizer failed: {error}", file=sys.stderr)
        raise SystemExit(1)
