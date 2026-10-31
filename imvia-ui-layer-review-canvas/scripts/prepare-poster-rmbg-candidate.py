import argparse
import json
import os
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError


MAX_ASPECT_DRIFT = 0.03
DEFAULT_SAFETY_MARGIN = 0.06


def _rgb_fill(fill_color):
    if not isinstance(fill_color, str) or len(fill_color) != 7 or not fill_color.startswith("#"):
        raise ValueError("fill color must be #RRGGBB")
    try:
        return tuple(int(fill_color[index:index + 2], 16) for index in (1, 3, 5))
    except ValueError as error:
        raise ValueError("fill color must be #RRGGBB") from error


def _save_atomic(image, output_path):
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp.png", dir=output_path.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        image.save(temporary_path, format="PNG")
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _placement(placement_bounds, output_size, safety_margin):
    if placement_bounds is None:
        return None
    if not isinstance(placement_bounds, dict):
        raise ValueError("placement bounds must be an object")
    if not isinstance(safety_margin, (int, float)) or safety_margin < 0 or safety_margin >= 0.5:
        raise ValueError("safety margin must be between 0 and 0.5")

    values = {}
    for name in ("x", "y", "width", "height"):
        value = placement_bounds.get(name)
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f"placement {name} must be an integer")
        values[name] = value
    if values["x"] < 0 or values["y"] < 0 or values["width"] < 1 or values["height"] < 1:
        raise ValueError("placement bounds must be positive and inside the source canvas")

    output_width, output_height = output_size
    if values["x"] + values["width"] > output_width or values["y"] + values["height"] > output_height:
        raise ValueError("placement bounds must be inside the source canvas")

    margin_x = round(values["width"] * safety_margin)
    margin_y = round(values["height"] * safety_margin)
    safe_width = values["width"] - (2 * margin_x)
    safe_height = values["height"] - (2 * margin_y)
    if safe_width < 1 or safe_height < 1:
        raise ValueError("placement safety margin leaves no usable area")
    return {
        "bounds": values,
        "safe_bounds": {
            "x": values["x"] + margin_x,
            "y": values["y"] + margin_y,
            "width": safe_width,
            "height": safe_height,
        },
        "safety_margin": float(safety_margin),
    }


def prepare_candidate(
    input_path,
    alpha_output_path,
    keyed_output_path,
    output_size,
    fill_color,
    placement_bounds=None,
    safety_margin=DEFAULT_SAFETY_MARGIN,
):
    output_width, output_height = output_size
    if output_width < 1 or output_height < 1:
        raise ValueError("output size must contain positive integers")
    fill = _rgb_fill(fill_color)

    try:
        with Image.open(input_path) as opened:
            if opened.format != "PNG":
                raise ValueError("RMBG output must be PNG")
            native = opened.convert("RGBA")
            native.load()
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError(f"RMBG output is unreadable: {error}") from error

    alpha_min, alpha_max = native.getchannel("A").getextrema()
    if alpha_min != 0 or alpha_max == 0:
        raise ValueError("RMBG output did not produce usable transparent pixels")

    native_aspect = native.width / native.height
    output_aspect = output_width / output_height
    aspect_drift = abs(native_aspect - output_aspect) / output_aspect
    placement = _placement(placement_bounds, output_size, safety_margin)
    alpha_bbox = native.getchannel("A").getbbox()
    if alpha_bbox is None:
        raise ValueError("RMBG output did not contain visible foreground pixels")

    if aspect_drift > MAX_ASPECT_DRIFT and placement is None:
        raise ValueError(
            f"RMBG output aspect ratio drift is too large: {native.width}x{native.height} "
            f"for {output_width}x{output_height}; confirmed source pixel bounds are required"
        )

    if aspect_drift > MAX_ASPECT_DRIFT:
        cropped = native.crop(alpha_bbox)
        target = placement["safe_bounds"]
        scale = min(target["width"] / cropped.width, target["height"] / cropped.height)
        offset = (
            target["x"] + (target["width"] - round(cropped.width * scale)) // 2,
            target["y"] + (target["height"] - round(cropped.height * scale)) // 2,
        )
        placement_mode = "confirmed_source_pixels"
    else:
        cropped = native
        scale = min(output_width / native.width, output_height / native.height)
        offset = None
        placement_mode = "source_canvas"

    scaled_size = (
        max(1, round(cropped.width * scale)),
        max(1, round(cropped.height * scale)),
    )
    scaled = cropped.resize(scaled_size, Image.Resampling.LANCZOS)
    if offset is None:
        offset = (
            (output_width - scaled.width) // 2,
            (output_height - scaled.height) // 2,
        )

    transparent = Image.new("RGBA", output_size, (0, 0, 0, 0))
    transparent.alpha_composite(scaled, offset)
    keyed = Image.new("RGB", output_size, fill)
    keyed.paste(transparent.convert("RGB"), (0, 0), transparent.getchannel("A"))

    _save_atomic(transparent, alpha_output_path)
    _save_atomic(keyed, keyed_output_path)
    return {
        "native": {"width": native.width, "height": native.height},
        "output": {"width": output_width, "height": output_height},
        "scaled": {"width": scaled.width, "height": scaled.height},
        "offset": {"x": offset[0], "y": offset[1]},
        "fill_color": fill_color.upper(),
        "real_alpha": True,
        "aspect_drift": aspect_drift,
        "scale": scale,
        "placement": {
            "mode": placement_mode,
            "bounds": placement["bounds"] if placement else None,
            "safe_bounds": placement["safe_bounds"] if placement else None,
            "safety_margin": placement["safety_margin"] if placement else None,
            "alpha_bbox": {
                "x": alpha_bbox[0],
                "y": alpha_bbox[1],
                "width": alpha_bbox[2] - alpha_bbox[0],
                "height": alpha_bbox[3] - alpha_bbox[1],
            },
        },
        "alpha_output": str(Path(alpha_output_path).resolve()),
        "keyed_output": str(Path(keyed_output_path).resolve()),
    }


def _arguments(argv=None):
    parser = argparse.ArgumentParser(
        description="Map one RMBG PNG to a full poster canvas and emit alpha preview plus keyed candidate."
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--alpha-output", required=True, type=Path)
    parser.add_argument("--keyed-output", required=True, type=Path)
    parser.add_argument("--source-width", required=True, type=int)
    parser.add_argument("--source-height", required=True, type=int)
    parser.add_argument("--fill-color", required=True)
    parser.add_argument("--placement-x", type=int)
    parser.add_argument("--placement-y", type=int)
    parser.add_argument("--placement-width", type=int)
    parser.add_argument("--placement-height", type=int)
    parser.add_argument("--safety-margin", type=float, default=DEFAULT_SAFETY_MARGIN)
    return parser.parse_args(argv)


def main(argv=None):
    arguments = _arguments(argv)
    placement_values = (
        arguments.placement_x,
        arguments.placement_y,
        arguments.placement_width,
        arguments.placement_height,
    )
    if any(value is not None for value in placement_values) and not all(value is not None for value in placement_values):
        raise ValueError("all placement bounds must be supplied together")
    placement_bounds = None
    if all(value is not None for value in placement_values):
        placement_bounds = {
            "x": arguments.placement_x,
            "y": arguments.placement_y,
            "width": arguments.placement_width,
            "height": arguments.placement_height,
        }
    result = prepare_candidate(
        arguments.input,
        arguments.alpha_output,
        arguments.keyed_output,
        (arguments.source_width, arguments.source_height),
        arguments.fill_color,
        placement_bounds=placement_bounds,
        safety_margin=arguments.safety_margin,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(2)
