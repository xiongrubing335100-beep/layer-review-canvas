import argparse
import json
import os
from pathlib import Path

from PIL import Image
from rembg import new_session, remove


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run RMBG as the final transparent-PNG step for one Codex split result.",
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="isnet-general-use")
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


def run_rmbg(input_path, output_path, model, expected_size, session_factory=new_session, remove_fn=remove):
    validate_input_size(input_path, expected_size)
    session = session_factory(model)
    result = remove_fn(input_path.read_bytes(), session=session, alpha_matting=False)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".rmbg-tmp")
    temporary_output.write_bytes(result)
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
    }


def main():
    args = parse_args()
    expected_size = (args.expected_width, args.expected_height)
    result = run_rmbg(args.input, args.output, args.model, expected_size)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
