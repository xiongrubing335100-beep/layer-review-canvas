import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


LANDSCAPE_CANVAS = (1536, 1024)
PORTRAIT_CANVAS = (1024, 1536)
SQUARE_CANVAS = (1024, 1024)
ALPHA_BLACK_POINT = 32
ALPHA_WHITE_POINT = 223
SOURCE_LOCK_MIN_DIMENSION = 16
SOURCE_LOCK_THUMBNAIL = 192
SOURCE_LOCK_MAX_SHIFT_RATIO = 0.18


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def choose_canvas(width, height):
    ratio = width / height
    if ratio > 1.2:
        return LANDSCAPE_CANVAS
    if ratio < 1 / 1.2:
        return PORTRAIT_CANVAS
    return SQUARE_CANVAS


def normalize_semantic_alpha(alpha):
    span = ALPHA_WHITE_POINT - ALPHA_BLACK_POINT
    return alpha.point(
        lambda value: 0
        if value <= ALPHA_BLACK_POINT
        else 255
        if value >= ALPHA_WHITE_POINT
        else round((value - ALPHA_BLACK_POINT) * 255 / span)
    )


def load_regular_png(path, label):
    resolved = path.resolve()
    if not resolved.is_file() or resolved.suffix.lower() != ".png":
        raise ValueError(f"{label} must be a regular PNG file")
    with Image.open(resolved) as image:
        if image.format != "PNG":
            raise ValueError(f"{label} must be PNG")
        return image.convert("RGBA")


def prepare(args):
    source = load_regular_png(args.source_crop, "source crop")
    width, height = source.size
    if width != args.expected_width or height != args.expected_height:
        raise ValueError("source crop dimensions do not match the frozen selected region")

    canvas_width, canvas_height = choose_canvas(width, height)
    scale = min(canvas_width / width, canvas_height / height)
    content_width = max(1, round(width * scale))
    content_height = max(1, round(height * scale))
    content_x = (canvas_width - content_width) // 2
    content_y = (canvas_height - content_height) // 2

    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 255))
    resized = source.resize((content_width, content_height), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, (content_x, content_y))
    args.reference.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.reference, format="PNG")

    mapping = {
        "version": 1,
        "job_id": args.job_id,
        "layer_index": args.layer_index,
        "snapshot_id": args.snapshot_id,
        "generated_input_kind": "codex_alpha_matte",
        "execution_route": "codex_rgba",
        "reference_path": str(args.reference.resolve()),
        "source_crop_path": str(args.source_crop.resolve()),
        "canvas": {"width": canvas_width, "height": canvas_height},
        "content_region": {
            "x": content_x,
            "y": content_y,
            "width": content_width,
            "height": content_height,
        },
        "expected_output": {"width": width, "height": height},
    }
    atomic_json(args.mapping, mapping)
    return {"mapping_path": str(args.mapping.resolve()), **mapping}


def mapped_content(matte, mapping, expected_size):
    canvas = mapping["canvas"]
    canvas_width = int(canvas["width"])
    canvas_height = int(canvas["height"])
    if canvas_width <= 0 or canvas_height <= 0:
        raise ValueError("codex_rgba mapping canvas is invalid")
    matte_width, matte_height = matte.size
    if matte_width * canvas_height != matte_height * canvas_width:
        raise ValueError("ImageGen matte aspect ratio does not match the prepared H5 canvas")

    region = mapping["content_region"]
    scale_x = matte_width / canvas_width
    scale_y = matte_height / canvas_height
    left = round(int(region["x"]) * scale_x)
    top = round(int(region["y"]) * scale_y)
    right = round((int(region["x"]) + int(region["width"])) * scale_x)
    bottom = round((int(region["y"]) + int(region["height"])) * scale_y)
    if left < 0 or top < 0 or right > matte_width or bottom > matte_height or right <= left or bottom <= top:
        raise ValueError("codex_rgba mapped content region is invalid")
    content = matte.crop((left, top, right, bottom))
    if content.size != expected_size:
        content = content.resize(expected_size, Image.Resampling.LANCZOS)
    return content


def source_saliency(source):
    """Return source-derived foreground evidence without changing source RGB."""
    rgb_image = source.convert("RGB")
    rgb = np.asarray(rgb_image, dtype=np.float32)
    height, width = rgb.shape[:2]
    blur_radius = max(3, min(48, round(min(width, height) * 0.075)))
    blurred = np.asarray(
        rgb_image.filter(ImageFilter.GaussianBlur(radius=blur_radius)),
        dtype=np.float32,
    )

    luma = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    blurred_luma = (
        blurred[..., 0] * 0.299
        + blurred[..., 1] * 0.587
        + blurred[..., 2] * 0.114
    )
    dark_contrast = np.maximum(blurred_luma - luma, 0) * 1.25

    border_size = max(1, round(min(width, height) * 0.04))
    border = np.concatenate((
        rgb[:border_size].reshape(-1, 3),
        rgb[-border_size:].reshape(-1, 3),
        rgb[:, :border_size].reshape(-1, 3),
        rgb[:, -border_size:].reshape(-1, 3),
    ))
    background = np.median(border, axis=0)
    background_delta = np.max(np.abs(rgb - background), axis=2) * 0.65

    # Directional contrast avoids creating an alpha halo on pale pixels next to
    # dark strokes. Colour distance retains saturated targets such as red text.
    signal = np.maximum(dark_contrast, background_delta)
    high = float(np.percentile(signal, 99.5))
    if high < 4:
        return np.zeros((height, width), dtype=np.float32)
    return np.clip(signal / high, 0, 1)


def source_alignment_evidence(source):
    """Prefer dark typography over colourful nearby illustration while aligning."""
    rgb = np.asarray(source.convert("RGB"), dtype=np.float32)
    luma = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    darkness = np.clip((235 - luma) / 185, 0, 1)
    return darkness * darkness


def translated_image(image, dx, dy):
    shifted = Image.new("L", image.size, 0)
    shifted.paste(image, (dx, dy))
    return shifted


def best_source_translation(alpha, saliency):
    width, height = alpha.size
    scale = min(1.0, SOURCE_LOCK_THUMBNAIL / max(width, height))
    thumbnail_size = (
        max(1, round(width * scale)),
        max(1, round(height * scale)),
    )
    semantic = np.asarray(
        alpha.resize(thumbnail_size, Image.Resampling.BILINEAR),
        dtype=np.float32,
    ) / 255
    evidence = np.asarray(
        Image.fromarray(np.uint8(np.clip(saliency * 255, 0, 255)), mode="L").resize(
            thumbnail_size,
            Image.Resampling.BILINEAR,
        ),
        dtype=np.float32,
    ) / 255

    semantic = np.where(semantic >= 0.12, semantic, 0)
    if np.count_nonzero(semantic) < 4 or float(evidence.max()) < 0.12:
        return 0, 0, 0.0

    thumb_width, thumb_height = thumbnail_size
    max_dx = max(1, round(thumb_width * SOURCE_LOCK_MAX_SHIFT_RATIO))
    max_dy = max(1, round(thumb_height * SOURCE_LOCK_MAX_SHIFT_RATIO))
    step = 1 if max(thumb_width, thumb_height) <= 128 else 2
    best = (-1.0, 0, 0)

    for dy in range(-max_dy, max_dy + 1, step):
        source_top = max(0, dy)
        source_bottom = min(thumb_height, thumb_height + dy)
        semantic_top = max(0, -dy)
        semantic_bottom = semantic_top + source_bottom - source_top
        if source_bottom <= source_top:
            continue
        for dx in range(-max_dx, max_dx + 1, step):
            source_left = max(0, dx)
            source_right = min(thumb_width, thumb_width + dx)
            semantic_left = max(0, -dx)
            semantic_right = semantic_left + source_right - source_left
            if source_right <= source_left:
                continue

            semantic_slice = semantic[
                semantic_top:semantic_bottom,
                semantic_left:semantic_right,
            ]
            evidence_slice = evidence[
                source_top:source_bottom,
                source_left:source_right,
            ]
            denominator = float(np.sqrt(
                np.sum(semantic_slice * semantic_slice)
                * np.sum(evidence_slice * evidence_slice)
            ))
            if denominator <= 1e-6:
                continue
            correlation = float(np.sum(semantic_slice * evidence_slice)) / denominator
            distance = np.hypot(dx / max_dx, dy / max_dy)
            score = correlation - float(distance) * 0.015
            if score > best[0]:
                best = (score, dx, dy)

    _, dx, dy = best
    full_dx = round(dx * width / thumb_width)
    full_dy = round(dy * height / thumb_height)
    return full_dx, full_dy, max(0.0, best[0])


def otsu_threshold(values):
    histogram = np.bincount(np.uint8(np.clip(values * 255, 0, 255)), minlength=256)
    total = int(histogram.sum())
    if total == 0:
        return 255
    weighted_total = float(np.dot(np.arange(256), histogram))
    background_weight = 0
    background_sum = 0.0
    best_variance = -1.0
    best_threshold = 0
    for threshold in range(256):
        background_weight += int(histogram[threshold])
        if background_weight == 0:
            continue
        foreground_weight = total - background_weight
        if foreground_weight == 0:
            break
        background_sum += threshold * int(histogram[threshold])
        background_mean = background_sum / background_weight
        foreground_mean = (weighted_total - background_sum) / foreground_weight
        variance = background_weight * foreground_weight * (background_mean - foreground_mean) ** 2
        if variance > best_variance:
            best_variance = variance
            best_threshold = threshold
    return best_threshold


def prune_small_row_bands(alpha):
    """Remove small source details separated vertically from the main target."""
    values = np.asarray(alpha)
    visible = values >= 32
    occupied_rows = np.any(visible, axis=1)
    bands = []
    start = None
    for row, occupied in enumerate(occupied_rows):
        if occupied and start is None:
            start = row
        if start is not None and (not occupied or row == len(occupied_rows) - 1):
            end = row if not occupied else row + 1
            area = int(np.count_nonzero(visible[start:end]))
            bands.append((start, end, area))
            start = None
    if len(bands) <= 1:
        return alpha

    total_area = sum(area for _, _, area in bands)
    minimum_area = max(8, round(total_area * 0.03))
    cleaned = values.copy()
    for start, end, area in bands:
        if area < minimum_area:
            cleaned[start:end] = 0
    return Image.fromarray(cleaned, mode="L")


def source_locked_alpha(source, semantic_alpha):
    """Use ImageGen only for semantics; derive delivered geometry from source pixels."""
    width, height = source.size
    if min(width, height) < SOURCE_LOCK_MIN_DIMENSION:
        return semantic_alpha, {"source_lock": "semantic_fallback_small_source"}

    saliency = source_saliency(source)
    alignment_evidence = source_alignment_evidence(source)
    dx, dy, alignment_score = best_source_translation(semantic_alpha, alignment_evidence)
    aligned = translated_image(semantic_alpha, dx, dy)
    semantic_pixels = np.asarray(aligned) >= 32
    semantic_y, semantic_x = np.nonzero(semantic_pixels)
    if semantic_x.size == 0:
        raise ValueError("ImageGen semantic matte has no source-locked foreground")
    # Ignore tiny disconnected ImageGen artefacts when deriving the semantic
    # region. The region is only a locator; delivered contours still come from
    # the frozen source crop.
    left = int(np.floor(np.quantile(semantic_x, 0.005)))
    right = int(np.ceil(np.quantile(semantic_x, 0.995))) + 1
    top = int(np.floor(np.quantile(semantic_y, 0.005)))
    bottom = int(np.ceil(np.quantile(semantic_y, 0.995))) + 1
    padding = max(2, round(min(width, height) * 0.015))
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(width, right + padding)
    bottom = min(height, bottom + padding)
    support_mask = np.zeros((height, width), dtype=bool)
    support_mask[top:bottom, left:right] = True
    semantic_rows = np.any(semantic_pixels, axis=1)
    row_kernel = np.ones(padding * 2 + 1, dtype=np.uint8)
    supported_rows = np.convolve(
        semantic_rows.astype(np.uint8),
        row_kernel,
        mode="same",
    ) > 0
    support_mask &= supported_rows[:, None]
    supported_values = saliency[support_mask]
    if supported_values.size < 8 or alignment_score < 0.08:
        raise ValueError("ImageGen semantic matte cannot be source-locked without geometric drift")

    threshold = max(18, otsu_threshold(supported_values)) / 255
    ramp = max(0.06, min(0.22, (1.0 - threshold) * 0.28))
    source_alpha = np.clip((saliency - threshold) / ramp, 0, 1)
    source_alpha *= support_mask
    output = Image.fromarray(np.uint8(np.rint(source_alpha * 255)), mode="L")
    output = prune_small_row_bands(output)

    semantic_area = np.count_nonzero(np.asarray(aligned) >= 32)
    output_area = np.count_nonzero(np.asarray(output) >= 32)
    if output.getbbox() is None or semantic_area == 0:
        raise ValueError("ImageGen semantic matte has no source-locked foreground")
    area_ratio = output_area / semantic_area
    if area_ratio < 0.08 or area_ratio > 3.5:
        raise ValueError("ImageGen semantic matte source-lock confidence is insufficient")
    return output, {
        "source_lock": "source_pixels",
        "source_lock_translation": [dx, dy],
        "source_lock_alignment_score": round(alignment_score, 4),
        "source_lock_area_ratio": round(area_ratio, 4),
    }


def compose(args):
    mapping = json.loads(args.mapping.read_text(encoding="utf-8"))
    if mapping.get("version") != 1 or mapping.get("generated_input_kind") != "codex_alpha_matte":
        raise ValueError("codex_rgba mapping is invalid")
    if mapping.get("job_id") != args.job_id or int(mapping.get("layer_index", 0)) != args.layer_index:
        raise ValueError("codex_rgba mapping does not match the current job and layer")
    if mapping.get("snapshot_id") != args.snapshot_id:
        raise ValueError("codex_rgba mapping snapshot is stale")

    source = load_regular_png(args.source_crop, "source crop")
    matte = load_regular_png(args.matte, "ImageGen matte")
    expected = mapping.get("expected_output") or {}
    expected_size = (int(expected.get("width", 0)), int(expected.get("height", 0)))
    if source.size != expected_size or expected_size[0] <= 0 or expected_size[1] <= 0:
        raise ValueError("codex_rgba source crop dimensions are invalid")

    content = mapped_content(matte, mapping, expected_size)
    alpha = content.convert("L")
    minimum, maximum = alpha.getextrema()
    if minimum > 16 or maximum < 239:
        raise ValueError("ImageGen matte must contain a black background and white subject")
    alpha = normalize_semantic_alpha(alpha)
    alpha_minimum, alpha_maximum = alpha.getextrema()
    if alpha_minimum != 0 or alpha_maximum != 255 or alpha.getbbox() is None:
        raise ValueError("ImageGen matte does not produce usable true alpha")

    alpha, source_lock = source_locked_alpha(source, alpha)
    alpha_minimum, alpha_maximum = alpha.getextrema()
    if alpha_minimum != 0 or alpha_maximum != 255 or alpha.getbbox() is None:
        raise ValueError("source-locked matte does not produce usable true alpha")

    result = source.convert("RGBA")
    result.putalpha(alpha)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output, format="PNG")
    return {
        "output_path": str(args.output.resolve()),
        "width": result.width,
        "height": result.height,
        "mode": result.mode,
        "alpha_extrema": [alpha_minimum, alpha_maximum],
        "source_rgb_locked": True,
        **source_lock,
    }


def parse_args():
    parser = argparse.ArgumentParser(description="Prepare or compose H5-style source-locked poster RGBA.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--source-crop", type=Path, required=True)
    prepare_parser.add_argument("--reference", type=Path, required=True)
    prepare_parser.add_argument("--mapping", type=Path, required=True)
    prepare_parser.add_argument("--job-id", required=True)
    prepare_parser.add_argument("--layer-index", type=int, required=True)
    prepare_parser.add_argument("--snapshot-id", required=True)
    prepare_parser.add_argument("--expected-width", type=int, required=True)
    prepare_parser.add_argument("--expected-height", type=int, required=True)

    compose_parser = subparsers.add_parser("compose")
    compose_parser.add_argument("--source-crop", type=Path, required=True)
    compose_parser.add_argument("--matte", type=Path, required=True)
    compose_parser.add_argument("--mapping", type=Path, required=True)
    compose_parser.add_argument("--output", type=Path, required=True)
    compose_parser.add_argument("--job-id", required=True)
    compose_parser.add_argument("--layer-index", type=int, required=True)
    compose_parser.add_argument("--snapshot-id", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    result = prepare(arguments) if arguments.command == "prepare" else compose(arguments)
    print(json.dumps(result, ensure_ascii=False))
