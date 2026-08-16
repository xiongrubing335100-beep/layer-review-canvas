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

from rembg import new_session, remove


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


def run_rmbg(input_path, output_path, model, expected_size, session_factory=new_session, remove_fn=remove):
    validate_input_size(input_path, expected_size)
    session = session_factory(model)
    with Image.open(input_path) as source_image:
        model_input, mapping = prepare_letterboxed_input(source_image, MODEL_INPUT_SIZE)
    model_input_bytes = BytesIO()
    model_input.save(model_input_bytes, format="PNG")
    result = remove_fn(model_input_bytes.getvalue(), session=session, alpha_matting=False)
    alpha = extract_letterboxed_alpha(result, mapping, expected_size)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".rmbg-tmp")
    temporary_output.write_bytes(preserve_source_rgb(input_path, alpha, expected_size))
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
        "source_rgb_locked": True,
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
