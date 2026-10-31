"""Capture failed native contour evidence without changing an archived task."""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("attempt")
parser.add_argument("output", help="New diagnostic directory only")
args = parser.parse_args()
attempt, output = Path(args.attempt).resolve(), Path(args.output).resolve()
manifest_path = attempt / "manifest.json"
raw_path = attempt / "raw.png"
manifest_bytes, raw_bytes = manifest_path.read_bytes(), raw_path.read_bytes()
manifest = json.loads(manifest_bytes)
spec = importlib.util.spec_from_file_location(
    "native_inspection_renderer", Path(__file__).with_name("v2-region-pixels.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
captured = {}

def capture(frame, event, arg):
    if (event == "exception"
            and frame.f_code.co_filename.endswith("/native-rgba-registration.py")
            and frame.f_code.co_name == "estimate_component_alignment"
            and "contour" in frame.f_locals):
        values = frame.f_locals
        captured.update(contour=values["contour"],
                        mapped=values["mapped"].copy(),
                        source=values["source_crop"].convert("RGB").copy(),
                        alignment=values["audit"])
    return capture

sys.settrace(capture)
try:
    renderer.render_region(manifest, raw_path)
except (ValueError, RuntimeError) as error:
    captured["error"] = str(error)
finally:
    sys.settrace(None)
if "mapped" not in captured:
    raise RuntimeError("No failed native contour was captured")
if manifest_path.read_bytes() != manifest_bytes or raw_path.read_bytes() != raw_bytes:
    raise RuntimeError("Archived inputs changed during inspection")
output.mkdir(parents=True, exist_ok=False)
mapped, source = captured.pop("mapped"), captured.pop("source")
source.save(output / "source.png")
Image.fromarray(mapped).save(output / "aligned-diagnostic-only.png")
regions = captured["contour"]["uncertainRegions"]
sheet = Image.new("RGB", (900, 230*len(regions)), "#333333")
draw = ImageDraw.Draw(sheet)
for row, region in enumerate(regions):
    x, y, w, h = (region[k] for k in ("x", "y", "width", "height"))
    box = (max(0, x-20), max(0, y-20), min(source.width, x+w+20), min(source.height, y+h+20))
    source_patch = source.crop(box)
    alpha = Image.fromarray(mapped[..., 3]).crop(box)
    rgba = Image.fromarray(mapped).crop(box)
    rgba = Image.alpha_composite(Image.new("RGBA", rgba.size, "#252525"), rgba).convert("RGB")
    for column, patch in enumerate((source_patch, alpha.convert("RGB"), rgba)):
        patch.thumbnail((280, 190))
        # Nearest-neighbour enlargement exposes actual pixels, not smoothed edges.
        scale = min(280/patch.width, 190/patch.height)
        patch = patch.resize((round(patch.width*scale), round(patch.height*scale)), Image.Resampling.NEAREST)
        sheet.paste(patch, (column*300, row*230+35))
    draw.text((0, row*230+5), f"{region} | SOURCE / ALPHA / ALIGNED RAW (NOT DELIVERY)", fill="white")
sheet.save(output / "regions.png")
captured.update(diagnosticOnly=True, rawSha256=hashlib.sha256(raw_bytes).hexdigest())
(output / "diagnosis.json").write_text(json.dumps(captured, indent=2))
print(json.dumps(captured))
