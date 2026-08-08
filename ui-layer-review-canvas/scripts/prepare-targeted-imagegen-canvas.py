import argparse
import json
import os
from pathlib import Path

from PIL import Image


LANDSCAPE_CANVAS = (1536, 1024)
PORTRAIT_CANVAS = (1024, 1536)
SQUARE_CANVAS = (1024, 1024)


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def load_layer(job_directory, layer_id):
    preflight = json.loads((job_directory / "preflight.json").read_text(encoding="utf-8"))
    for layer in preflight.get("layers", []):
        if str(layer.get("id")) == str(layer_id):
            return layer
    raise ValueError(f"layer not found in preflight: {layer_id}")


def choose_canvas(width, height):
    ratio = width / height
    if ratio > 1.2:
        return LANDSCAPE_CANVAS
    if ratio < 1 / 1.2:
        return PORTRAIT_CANVAS
    return SQUARE_CANVAS


def prepare_canvas(job_id, layer_id, *, jobs_root):
    job_directory = (jobs_root / job_id).resolve()
    if job_directory.name != job_id:
        raise ValueError("job directory does not match jobId")
    layer = load_layer(job_directory, layer_id)
    if layer.get("execution_route_hint") != "codex_rgba":
        raise ValueError("ImageGen matte canvas is only valid for codex_rgba")

    output = layer.get("expected_output") or {}
    width = int(output.get("width", 0))
    height = int(output.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError("expected output dimensions are invalid")

    crop_path = Path(layer.get("crop_path", "")).resolve()
    if not crop_path.is_file():
        raise ValueError("targeted crop does not exist")
    with Image.open(crop_path) as source:
        crop = source.convert("RGBA")
    if crop.size != (width, height):
        raise ValueError(f"targeted crop must already be {width}x{height}")

    canvas_width, canvas_height = choose_canvas(width, height)
    scale = min(canvas_width / width, canvas_height / height)
    roi_width = max(1, round(width * scale))
    roi_height = max(1, round(height * scale))
    roi_x = (canvas_width - roi_width) // 2
    roi_y = (canvas_height - roi_height) // 2

    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 255))
    resized = crop.resize((roi_width, roi_height), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, (roi_x, roi_y))

    generated_directory = job_directory / "generated"
    generated_directory.mkdir(parents=True, exist_ok=True)
    stem = str(layer_id).replace("/", "-")
    reference_path = generated_directory / f"{stem}-imagegen-reference.png"
    mapping_path = generated_directory / f"{stem}-imagegen-mapping.json"
    canvas.convert("RGB").save(reference_path, format="PNG")

    mapping = {
        "version": 1,
        "job_id": job_id,
        "layer_id": layer_id,
        "generated_input_kind": "codex_alpha_matte",
        "reference_path": str(reference_path),
        "canvas": {"width": canvas_width, "height": canvas_height},
        "content_region": {
            "x": roi_x,
            "y": roi_y,
            "width": roi_width,
            "height": roi_height,
        },
        "expected_output": {"width": width, "height": height},
    }
    atomic_json(mapping_path, mapping)
    return mapping_path, mapping


def parse_args():
    parser = argparse.ArgumentParser(description="Prepare a source-locked ImageGen canvas for Codex RGBA matte generation.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--layer-id", required=True)
    parser.add_argument("--jobs-root", type=Path, default=Path("output") / "jobs")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    mapping_path, mapping = prepare_canvas(
        args.job_id,
        args.layer_id,
        jobs_root=args.jobs_root.resolve(),
    )
    print(json.dumps({"mapping_path": str(mapping_path), **mapping}, ensure_ascii=False))
