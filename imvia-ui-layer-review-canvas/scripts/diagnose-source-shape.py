"""Offline observation only. Never finalizes an attempt or changes its policy.

Compare an existing source-assembly recovery with a failed native proposal.
Any resulting pixels are diagnostic, including when an internal gate rejects.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


parser = argparse.ArgumentParser()
parser.add_argument("--attempt", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--matrix", required=True, help="Diagnostic proposed 2x3 transform JSON")
parser.add_argument("--method", choices=["assembly", "contour"], default="assembly")
args = parser.parse_args()
attempt, output = Path(args.attempt), Path(args.output)
output.mkdir(parents=True, exist_ok=False)
registration = load("diagnostic_registration", "native-rgba-registration.py")
source_module = load("diagnostic_source", "source-guided-matte.py")
source = Image.open(attempt / "selected-crop.png").convert("RGB")
raw = Image.open(attempt / "raw.png").convert("RGBA")
mapping = json.loads((attempt / "mapping.json").read_text())
proposal = registration.sample_aligned(raw, np.asarray(json.loads(args.matrix)), mapping, source.size)
alpha = np.asarray(proposal)[..., 3]
foreground = alpha >= 128
holes, _ = nd.label(nd.binary_fill_holes(foreground) & ~foreground)
observed = {}


def trace(frame, event, arg):
    if frame.f_code is source_module.source_assembly_matte.__code__ and event == "return":
        observed.update(frame.f_locals)
    return trace


if args.method == "assembly":
    sys.settrace(trace)
    try:
        result = source_module.source_assembly_matte(
            source, Image.fromarray(alpha), np.ones(alpha.shape, bool),
            (holes, np.zeros(alpha.shape, bool), []))
    finally:
        sys.settrace(None)
else:
    result = None
    recovered = source_module.register_source_contours(
        np.asarray(source), alpha, 24, foreground, source_search=True)
    observed["visible"] = recovered >= 128
    Image.fromarray(recovered).save(output / "contour-coverage.png")
visible = observed.get("visible")
report = {"diagnosticOnly": True, "formalAttemptUnchanged": True,
          "method": args.method,
          "semanticInspectionProvided": False, "algorithmReturned": result is not None}
if visible is not None:
    audit, _ = source_module.source_contour_evidence(
        np.asarray(source), visible, np.zeros_like(visible), material=True)
    report.update({"sourceContour": audit, "changedPixels": int((visible != foreground).sum()),
                   "componentsBefore": int(nd.label(foreground)[1]),
                   "componentsAfter": int(nd.label(visible)[1]),
                   "holesBefore": int(nd.label(nd.binary_fill_holes(foreground) & ~foreground)[1]),
                   "holesAfter": int(nd.label(nd.binary_fill_holes(visible) & ~visible)[1])})
    rgba = np.dstack((np.asarray(source), visible.astype(np.uint8) * 255))
    image = Image.fromarray(rgba)
    for name, color in (("dark", (32, 32, 32, 255)), ("light", (240, 240, 240, 255))):
        Image.alpha_composite(Image.new("RGBA", source.size, color), image).save(output / f"{name}.png")
    Image.fromarray(visible.astype(np.uint8) * 255).save(output / "diagnostic-alpha.png")
(output / "diagnosis.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))
