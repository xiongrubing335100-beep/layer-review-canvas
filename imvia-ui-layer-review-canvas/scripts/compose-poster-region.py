import argparse
import os
from pathlib import Path

from PIL import Image


def compose_region(input_path, output_path, source_width, source_height, x, y, width, height, fill_color):
    fill = tuple(int(fill_color[index:index + 2], 16) for index in (1, 3, 5))
    with Image.open(input_path) as opened:
        region = opened.convert("RGBA")
        if region.size != (width, height):
            raise ValueError("region asset dimensions do not match placement")
        if x < 0 or y < 0 or x + width > source_width or y + height > source_height:
            raise ValueError("placement exceeds source canvas")
        canvas = Image.new("RGB", (source_width, source_height), fill)
        if region.getchannel("A").getextrema() == (255, 255):
            canvas.paste(region.convert("RGB"), (x, y))
        else:
            canvas.paste(region.convert("RGB"), (x, y), region.getchannel("A"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(output_path, format="PNG")


def main():
    parser = argparse.ArgumentParser(description="Place one targeted region asset on a temporary full poster canvas.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-width", required=True, type=int)
    parser.add_argument("--source-height", required=True, type=int)
    parser.add_argument("--x", required=True, type=int)
    parser.add_argument("--y", required=True, type=int)
    parser.add_argument("--width", required=True, type=int)
    parser.add_argument("--height", required=True, type=int)
    parser.add_argument("--fill-color", required=True)
    args = parser.parse_args()
    compose_region(
        args.input,
        args.output,
        args.source_width,
        args.source_height,
        args.x,
        args.y,
        args.width,
        args.height,
        args.fill_color,
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=os.sys.stderr)
        raise SystemExit(2)
