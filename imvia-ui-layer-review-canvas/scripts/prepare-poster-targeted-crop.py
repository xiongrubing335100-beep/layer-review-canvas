import argparse
import json
import os
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError


def _positive(value, label):
    if not isinstance(value, int) or value < 1:
        raise ValueError(f"{label} must be a positive integer")
    return value


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


def freeze_crop(source_path, output_path, bounds):
    x = int(bounds["x"])
    y = int(bounds["y"])
    width = _positive(int(bounds["width"]), "width")
    height = _positive(int(bounds["height"]), "height")
    if x < 0 or y < 0:
        raise ValueError("crop origin must not be negative")
    try:
        with Image.open(source_path) as opened:
            if opened.format != "PNG":
                raise ValueError("poster source must be PNG")
            source = opened.convert("RGBA")
            source.load()
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError(f"poster source is unreadable: {error}") from error
    if x + width > source.width or y + height > source.height:
        raise ValueError("confirmed crop exceeds the source canvas")
    crop = source.crop((x, y, x + width, y + height))
    _save_atomic(crop, output_path)
    return {
        "crop_path": str(Path(output_path).resolve()),
        "bounds": {"x": x, "y": y, "width": width, "height": height},
        "source": {"width": source.width, "height": source.height},
        "crop": {"width": crop.width, "height": crop.height},
    }


def _arguments(argv=None):
    parser = argparse.ArgumentParser(description="Freeze one confirmed poster selection as an exact PNG crop.")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--x", required=True, type=int)
    parser.add_argument("--y", required=True, type=int)
    parser.add_argument("--width", required=True, type=int)
    parser.add_argument("--height", required=True, type=int)
    return parser.parse_args(argv)


def main(argv=None):
    arguments = _arguments(argv)
    result = freeze_crop(arguments.source, arguments.output, {
        "x": arguments.x,
        "y": arguments.y,
        "width": arguments.width,
        "height": arguments.height,
    })
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(2)
