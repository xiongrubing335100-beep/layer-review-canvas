"""Read-only replay of an initial native result, exposing edge-color weights."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("attempt")
parser.add_argument("output")
parser.add_argument("--region", nargs=4, type=int, required=True, metavar=("X", "Y", "W", "H"))
args = parser.parse_args()
attempt, output = Path(args.attempt).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False)
captured = {}


def trace(frame, event, arg):
    if event == "return" and frame.f_code.co_name == "native_boundary_repair_mask":
        captured.update({key: frame.f_locals[key].copy()
                         for key in ("source", "proposed", "distance", "weights")})
    return trace


spec = importlib.util.spec_from_file_location("edge_color_renderer", Path(__file__).with_name("v2-region-pixels.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
manifest = json.loads((attempt / "manifest.json").read_text())
sys.settrace(trace)
try:
    result, audit = renderer.render_region(manifest, attempt / "raw.png", _defer_component_contour=True)
finally:
    sys.settrace(None)
result.save(output / "composited.png")
Image.fromarray(captured["proposed"].astype(np.uint8)).save(output / "aligned.png")
Image.fromarray(np.rint(captured["weights"]*255).astype(np.uint8)).save(output / "weights.png")
values = np.asarray(result).astype(int)
x, y, w, h = args.region
region = np.zeros(values.shape[:2], bool)
region[y:y+h, x:x+w] = True
# Rank chromatic contamination for inspection, never use it to edit pixels.
chroma = np.minimum(values[..., 0]-values[..., 1], values[..., 2]-values[..., 1])
points = np.argwhere(region & (values[..., 3] >= 128) & (chroma > 20))
points = sorted(points.tolist(), key=lambda point: -int(chroma[tuple(point)]))[:24]
report = {"diagnosticOnly": True, "region": args.region, "samples": []}
for py, px in points:
    report["samples"].append({
        "xy": [px, py], "source": captured["source"][py, px].tolist(),
        "model": captured["proposed"][py, px].tolist(), "final": values[py, px].tolist(),
        "weight": float(captured["weights"][py, px]),
        "distance": float(captured["distance"][py, px]),
    })
(output / "diagnosis.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))
