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


VALIDATION_KEYS = (
    "count",
    "dimensions",
    "alpha",
    "annotation_conformance",
    "obvious_exclusion",
    "structure_integrity",
)

CODEX_RGBA_CATEGORIES = {"kvTitle", "ordinaryText", "logo"}


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def load_plan(job_directory):
    return json.loads((job_directory / "layer-review-plan.json").read_text(encoding="utf-8"))


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
    locked = candidate.copy()
    repair_mask = Image.new("1", (width, height), 0)
    for region in regions:
        repair_mask.paste(1, (
            int(region["x"]),
            int(region["y"]),
            int(region["x"]) + int(region["width"]),
            int(region["y"]) + int(region["height"]),
        ))
    locked.paste(source_crop, mask=Image.eval(repair_mask, lambda value: 1 - value))
    return locked


def run_rmbg(input_path, output_path, width, height, rmbg_script):
    subprocess.run([
        sys.executable,
        str(rmbg_script),
        "--input", str(input_path),
        "--output", str(output_path),
        "--model", "isnet-general-use",
        "--expected-width", str(width),
        "--expected-height", str(height),
    ], check=True, capture_output=True, text=True)


def resolve_transparency_strategy(layer):
    explicit = layer.get("transparency_strategy")
    if explicit in ("none", "codex_rgba", "rembg"):
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


def load_imagegen_mapping(mapping_path, generated_root, job_id, layer_id, width, height):
    resolved = Path(mapping_path).resolve()
    if not contained(resolved, generated_root):
        raise ValueError("ImageGen mapping must be inside the job generated directory")
    if not resolved.is_file():
        raise ValueError("ImageGen mapping does not exist")
    mapping = json.loads(resolved.read_text(encoding="utf-8"))
    if mapping.get("job_id") != job_id or str(mapping.get("layer_id")) != str(layer_id):
        raise ValueError("ImageGen mapping does not match the current job and layer")
    if mapping.get("generated_input_kind") != "codex_alpha_matte":
        raise ValueError("unsupported ImageGen mapping kind")
    expected = mapping.get("expected_output") or {}
    if (int(expected.get("width", 0)), int(expected.get("height", 0))) != (width, height):
        raise ValueError("ImageGen mapping expected output does not match the plan")
    return mapping


def compose_source_locked_matte(candidate, source_crop, mapping, width, height):
    canvas = mapping.get("canvas") or {}
    canvas_size = (int(canvas.get("width", 0)), int(canvas.get("height", 0)))
    if candidate.size != canvas_size:
        raise ValueError(f"ImageGen matte must preserve the prepared {canvas_size[0]}x{canvas_size[1]} canvas")

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
        raise ValueError("ImageGen matte content region is invalid")

    alpha = candidate.convert("L").crop((x, y, x + region_width, y + region_height))
    alpha_min, alpha_max = alpha.getextrema()
    if alpha_min > 16 or alpha_max < 239:
        raise ValueError("ImageGen matte must contain a black background and white subject")
    if alpha.size != (width, height):
        alpha = alpha.resize((width, height), Image.Resampling.LANCZOS)

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
):
    job_directory = (jobs_root / job_id).resolve()
    if job_directory.name != job_id:
        raise ValueError("job directory does not match jobId")
    plan = load_plan(job_directory)
    layer = find_layer(plan, layer_id)
    width, height, source_x, source_y = expected_output(layer)
    generated_root = (job_directory / "generated").resolve()
    generated_path = Path(generated_input).resolve()
    if not contained(generated_path, generated_root):
        raise ValueError("ImageGen input must be inside the job generated directory")
    if not generated_path.is_file():
        raise ValueError("ImageGen input does not exist")

    final_directory = (job_directory / "final").resolve()
    planned_output = Path(plan.get("output_directory", final_directory)).resolve()
    if planned_output != final_directory:
        raise ValueError("planned output directory must be the current job final directory")
    final_directory.mkdir(parents=True, exist_ok=True)
    output_name = f"{str(layer.get('id') or layer_id).replace('/', '-')}.png"
    final_path = final_directory / output_name
    temporary_directory = Path(tempfile.mkdtemp(prefix="targeted-finalize-", dir=generated_root))
    temporary_candidate = temporary_directory / "candidate.png"
    temporary_output = temporary_directory / "output.png"
    started = clock()
    try:
        with Image.open(generated_path) as image:
            candidate = image.convert("RGBA")
        transparency = resolve_transparency_strategy(layer)
        mapping = None
        if imagegen_mapping is not None:
            if transparency != "codex_rgba":
                raise ValueError("ImageGen mapping is only valid for codex_rgba")
            mapping = load_imagegen_mapping(
                imagegen_mapping,
                generated_root,
                job_id,
                layer.get("id") or layer_id,
                width,
                height,
            )
        elif candidate.size != (width, height):
            raise ValueError(f"ImageGen input must already be {width}x{height}")
        regions = validate_repair_regions(layer, width, height)
        if regions:
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

        rmbg_required = transparency == "rembg"
        rmbg_started = None
        rmbg_completed = None
        if rmbg_required:
            rmbg_started = clock()
            rmbg_runner(temporary_candidate, temporary_output, width, height, rmbg_script)
            rmbg_completed = clock()
            validation_started = clock()
            final_image = validate_png(temporary_output, width, height, True)
        else:
            validation_started = clock()
            final_image = validate_png(temporary_candidate, width, height, remove_background)
        if remove_background:
            validate_transparent_structure(final_image, "final PNG")
        final_image.save(temporary_output, format="PNG")
        os.replace(temporary_output, final_path)
        completed = clock()
        report = {
            "status": "completed",
            "execution_route": layer.get("execution_route_hint"),
            "layer_id": layer.get("id") or layer_id,
            "output": str(final_path),
            "timing": {
                **(plan.get("execution_timing") or {}),
                "postprocess_started_at": started,
                **({"rmbg_started_at": rmbg_started} if rmbg_started else {}),
                **({"rmbg_completed_at": rmbg_completed} if rmbg_completed else {}),
                "validation_started_at": validation_started,
                "completed_at": completed,
            },
            "validation_results": {key: True for key in VALIDATION_KEYS},
            "rmbg": {
                "required": rmbg_required,
                "model": "isnet-general-use" if rmbg_required else None,
            },
            "transparency": {
                "strategy": transparency,
                "structure_validation": "source_rgb_and_alpha" if transparency == "codex_rgba" else "alpha",
                "generated_input_kind": mapping.get("generated_input_kind") if mapping else "rgba_candidate",
            },
        }
        atomic_json(job_directory / "execution-report.json", report)
        return report
    except Exception as error:
        report = {
            "status": "failed",
            "execution_route": layer.get("execution_route_hint"),
            "layer_id": layer.get("id") or layer_id,
            "error": str(error),
            "timing": {"postprocess_started_at": started, "completed_at": clock()},
            "validation_results": {key: False for key in VALIDATION_KEYS},
        }
        atomic_json(job_directory / "execution-report.json", report)
        raise
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)


def parse_args():
    parser = argparse.ArgumentParser(description="Finalize one targeted ImageGen split result.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--layer-id", required=True)
    parser.add_argument("--generated-input", required=True, type=Path)
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
