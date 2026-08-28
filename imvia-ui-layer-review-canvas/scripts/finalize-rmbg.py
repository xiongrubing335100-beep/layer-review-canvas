import argparse
from io import BytesIO
import json
import os
from pathlib import Path

from PIL import Image

# PyMatting is imported by rembg even when alpha matting is disabled. The
# bundled Python runtime may not expose package source locations to Numba's
# cache writer, so disable JIT caching for this short-lived CLI process.
os.environ.setdefault("NUMBA_DISABLE_JIT", "1")

DEFAULT_RMBG_MODEL = "bria-rmbg"
MODEL_INPUT_SIZE = (1024, 1024)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run RMBG as the final transparent-PNG step for one Codex split result.",
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default=DEFAULT_RMBG_MODEL)
    parser.add_argument("--expected-width", required=True, type=int)
    parser.add_argument("--expected-height", required=True, type=int)
    return parser.parse_args()


def validate_input_size(input_path, expected_size):
    with Image.open(input_path) as image:
        source_size = image.size
    if source_size != expected_size:
        raise ValueError(
            f"RMBG input must already be the final split size: "
            f"expected {expected_size[0]}x{expected_size[1]}, "
            f"got {source_size[0]}x{source_size[1]}"
        )


def validate_rmbg_output(output_path, expected_size):
    with Image.open(output_path) as image:
        rgba = image.convert("RGBA")
        if rgba.size != expected_size:
            raise ValueError(
                f"RMBG changed the split size to {rgba.width}x{rgba.height}"
            )
        alpha_min, alpha_max = rgba.getchannel("A").getextrema()
        if alpha_min != 0 or alpha_max == 0:
            raise ValueError("RMBG did not produce usable transparent pixels")
        rgba.save(output_path, format="PNG")


def average_corner_color(image):
    rgb = image.convert("RGB")
    corners = (
        rgb.getpixel((0, 0)),
        rgb.getpixel((rgb.width - 1, 0)),
        rgb.getpixel((0, rgb.height - 1)),
        rgb.getpixel((rgb.width - 1, rgb.height - 1)),
    )
    return tuple(round(sum(pixel[channel] for pixel in corners) / len(corners)) for channel in range(3))


def _median(values):
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def alpha_mask_statistics(alpha):
    """Return coverage metrics used to reject BRIA's near-opaque false positive."""
    pixel_data = alpha.get_flattened_data() if hasattr(alpha, "get_flattened_data") else alpha.getdata()
    values = list(pixel_data)
    total = max(1, len(values))
    return {
        "transparent_share": sum(value <= 16 for value in values) / total,
        "non_opaque_share": sum(value < 239 for value in values) / total,
        "opaque_share": sum(value >= 239 for value in values) / total,
    }


def alpha_mask_is_nearly_opaque(statistics):
    """Detect masks where sparse transparent noise hides a failed cutout."""
    return (
        statistics["transparent_share"] < 0.005
        and statistics["non_opaque_share"] < 0.02
    )


def chroma_fallback_alpha(input_path, expected_size):
    """Extract alpha from a boundary-connected green field when RMBG is opaque.

    ImageGen text/logo candidates commonly arrive as a graphic on a green field.
    BRIA can classify that flat graphic as one rectangular object and return an
    opaque alpha.  This fallback is deliberately limited to a strongly green,
    mostly uniform boundary so natural-image candidates never enter this path.
    """
    with Image.open(input_path) as opened:
        rgb = opened.convert("RGB")
        if rgb.size != expected_size:
            raise ValueError("chroma fallback input size changed")
        pixels = rgb.load()
        boundary = []
        step_x = max(1, rgb.width // 512)
        step_y = max(1, rgb.height // 512)
        for x in range(0, rgb.width, step_x):
            boundary.extend((pixels[x, 0], pixels[x, rgb.height - 1]))
        for y in range(0, rgb.height, step_y):
            boundary.extend((pixels[0, y], pixels[rgb.width - 1, y]))
        key = tuple(_median([pixel[channel] for pixel in boundary]) for channel in range(3))
        if key[1] < 150 or key[1] - max(key[0], key[2]) < 70:
            raise ValueError("RMBG alpha is unusable and no safe green boundary field was detected")
        boundary_distances = [sum((pixel[channel] - key[channel]) ** 2 for channel in range(3)) ** 0.5 for pixel in boundary]
        uniform_share = sum(distance <= 48 for distance in boundary_distances) / max(1, len(boundary_distances))
        if uniform_share < 0.78:
            raise ValueError("RMBG alpha is unusable and the green boundary is not uniform enough for safe keying")
        key_green_excess = key[1] - max(key[0], key[2])
        alpha_values = []
        pixel_data = rgb.get_flattened_data() if hasattr(rgb, "get_flattened_data") else rgb.getdata()
        for pixel in pixel_data:
            green_excess = max(0, pixel[1] - max(pixel[0], pixel[2]))
            background_share = min(1.0, green_excess / key_green_excess)
            if background_share >= 0.9:
                alpha_values.append(0)
            elif background_share <= 0.12:
                alpha_values.append(255)
            else:
                alpha_values.append(round((0.9 - background_share) * 255 / 0.78))
        alpha = Image.new("L", expected_size)
        alpha.putdata(alpha_values)
        alpha_min, alpha_max = alpha.getextrema()
        if alpha_min != 0 or alpha_max == 0:
            raise ValueError("green boundary keying did not produce usable transparent pixels")
        return alpha, key


def prepare_letterboxed_input(image, canvas_size=MODEL_INPUT_SIZE):
    source = image.convert("RGBA")
    canvas_width, canvas_height = canvas_size
    scale = min(canvas_width / source.width, canvas_height / source.height)
    content_width = max(1, round(source.width * scale))
    content_height = max(1, round(source.height * scale))
    content_x = (canvas_width - content_width) // 2
    content_y = (canvas_height - content_height) // 2
    background = average_corner_color(source)
    canvas = Image.new("RGBA", canvas_size, (*background, 255))
    resized = source.resize((content_width, content_height), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, (content_x, content_y))
    mapping = {
        "canvas": {"width": canvas_width, "height": canvas_height},
        "content_region": {
            "x": content_x,
            "y": content_y,
            "width": content_width,
            "height": content_height,
        },
        "source": {"width": source.width, "height": source.height},
    }
    return canvas, mapping


def extract_letterboxed_alpha(rmbg_bytes, mapping, expected_size):
    with Image.open(BytesIO(rmbg_bytes)) as model_image:
        model = model_image.convert("RGBA")
        canvas = mapping["canvas"]
        canvas_size = (canvas["width"], canvas["height"])
        if model.size != canvas_size:
            raise ValueError(
                f"RMBG changed the model canvas to {model.width}x{model.height}"
            )
        region = mapping["content_region"]
        alpha = model.getchannel("A").crop((
            region["x"],
            region["y"],
            region["x"] + region["width"],
            region["y"] + region["height"],
        ))
        if alpha.size != expected_size:
            alpha = alpha.resize(expected_size, Image.Resampling.LANCZOS)
        return alpha


def preserve_source_rgb(input_path, alpha, expected_size):
    """Keep the submitted split RGB and take only the model-authored alpha."""
    with Image.open(input_path) as source_image:
        source = source_image.convert("RGBA")
        if alpha.size != expected_size:
            raise ValueError(
                f"RMBG changed the split size to {alpha.width}x{alpha.height}"
            )
        source.putalpha(alpha)
        output = BytesIO()
        source.save(output, format="PNG")
        return output.getvalue()


def decontaminate_chroma_rgb(input_path, alpha, key, expected_size):
    """Remove the detected key contribution from partially transparent edges."""
    with Image.open(input_path) as source_image:
        source = source_image.convert("RGB")
        if source.size != expected_size or alpha.size != expected_size:
            raise ValueError("chroma decontamination size changed")
        clean = Image.new("RGBA", expected_size)
        cleaned_pixels = []
        source_data = source.get_flattened_data() if hasattr(source, "get_flattened_data") else source.getdata()
        alpha_data = alpha.get_flattened_data() if hasattr(alpha, "get_flattened_data") else alpha.getdata()
        for pixel, alpha_value in zip(source_data, alpha_data):
            if alpha_value in (0, 255):
                cleaned_pixels.append((*pixel, alpha_value))
                continue
            opacity = alpha_value / 255.0
            foreground = tuple(
                max(0, min(255, round((pixel[channel] - (1.0 - opacity) * key[channel]) / opacity)))
                for channel in range(3)
            )
            cleaned_pixels.append((*foreground, alpha_value))
        clean.putdata(cleaned_pixels)
        output = BytesIO()
        clean.save(output, format="PNG")
        return output.getvalue()


def run_rmbg(input_path, output_path, model, expected_size, session_factory=None, remove_fn=None):
    validate_input_size(input_path, expected_size)
    if session_factory is None or remove_fn is None:
        from rembg import new_session, remove
        session_factory = session_factory or new_session
        remove_fn = remove_fn or remove
    session = session_factory(model)
    with Image.open(input_path) as source_image:
        model_input, mapping = prepare_letterboxed_input(source_image, MODEL_INPUT_SIZE)
    model_input_bytes = BytesIO()
    model_input.save(model_input_bytes, format="PNG")
    result = remove_fn(model_input_bytes.getvalue(), session=session, alpha_matting=False)
    alpha = extract_letterboxed_alpha(result, mapping, expected_size)
    alpha_source = "bria_rmbg"
    chroma_key = None
    alpha_min, alpha_max = alpha.getextrema()
    alpha_statistics = alpha_mask_statistics(alpha)
    fallback_reason = None
    alpha_range_is_unusable = alpha_min != 0 or alpha_max == 0
    near_opaque_mask = alpha_mask_is_nearly_opaque(alpha_statistics)
    if alpha_range_is_unusable or near_opaque_mask:
        try:
            alpha, chroma_key = chroma_fallback_alpha(input_path, expected_size)
        except ValueError:
            if alpha_range_is_unusable:
                raise
        else:
            alpha_source = "chroma_fallback"
            fallback_reason = "unusable_alpha_range" if alpha_range_is_unusable else "near_opaque_green_screen"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".rmbg-tmp")
    if chroma_key is None:
        output_bytes = preserve_source_rgb(input_path, alpha, expected_size)
    else:
        output_bytes = decontaminate_chroma_rgb(input_path, alpha, chroma_key, expected_size)
    temporary_output.write_bytes(output_bytes)
    try:
        validate_rmbg_output(temporary_output, expected_size)
        os.replace(temporary_output, output_path)
    finally:
        temporary_output.unlink(missing_ok=True)

    return {
        "engine": "rembg",
        "model": model,
        "input": str(input_path.resolve()),
        "output": str(output_path.resolve()),
        "width": expected_size[0],
        "height": expected_size[1],
        "real_alpha": True,
        "alpha_source": alpha_source,
        "bria_alpha_statistics": alpha_statistics,
        **({"fallback_reason": fallback_reason} if fallback_reason else {}),
        **({"chroma_key": "#%02X%02X%02X" % chroma_key} if chroma_key else {}),
        "source_rgb_locked": chroma_key is None,
        "chroma_decontaminated": chroma_key is not None,
        "preprocess": "letterbox",
        "model_canvas": mapping["canvas"],
        "content_region": mapping["content_region"],
    }


def main():
    args = parse_args()
    expected_size = (args.expected_width, args.expected_height)
    result = run_rmbg(args.input, args.output, args.model, expected_size)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
