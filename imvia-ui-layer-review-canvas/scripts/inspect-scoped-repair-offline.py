"""Reproduce archived repair processing without reopening or finalizing a task."""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("attempt")
parser.add_argument("output", help="New diagnostic directory only")
args = parser.parse_args()
attempt, output = Path(args.attempt).resolve(), Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False)
manifest = json.loads((attempt / "manifest.json").read_text())
review = json.loads((attempt / "review.json").read_text())
rejected = json.loads((attempt / "rejected.json").read_text())
manifest["scopedNativeRepair"] = {
    **review["scopedRepair"], "version": 1,
    "parentRawSha256": review["rawSha256"], "defects": rejected["defects"]}
spec = importlib.util.spec_from_file_location("diagnostic_renderer", Path(__file__).with_name("v2-region-pixels.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
report = {"diagnosticOnly": True, "attemptUnchanged": True,
          "initialRawSha256": review["rawSha256"], "repairRawSha256": review["scopedRepair"]["rawSha256"]}
def capture_merge(frame, event, arg):
    if (event == "call" and frame.f_code.co_name == "merge_scoped_repair"
            and frame.f_locals.get("source") is not None):
        for key in ("initial", "repaired", "permission", "source"):
            frame.f_locals[key].save(output / f"merge-{key}.png")
    return capture_merge

sys.settrace(capture_merge)
try:
    result, audit = renderer.render_region(manifest, attempt / "raw.png")
    result.save(output / "preview.png")
    for name, color in (("dark", "#252525"), ("light", "#eeeeee")):
        Image.alpha_composite(Image.new("RGBA", result.size, color), result).save(output / f"{name}.png")
    report.update(pixelAudit=audit, rgbaSha256=hashlib.sha256(result.tobytes()).hexdigest())
except (ValueError, RuntimeError) as error:
    report["error"] = str(error)
    if getattr(error, "diagnostic_result", None) is not None:
        report["rejectedAudit"] = error.diagnostic_audit
        for name, color in (("dark", "#252525"), ("light", "#eeeeee")):
            Image.alpha_composite(Image.new("RGBA", error.diagnostic_result.size, color),
                                  error.diagnostic_result).save(output / f"rejected-{name}.png")
finally:
    sys.settrace(None)
if (output / "merge-initial.png").exists():
    import numpy as np
    from scipy import ndimage
    initial = np.asarray(Image.open(output / "merge-initial.png"))
    source = np.asarray(Image.open(output / "merge-source.png").convert("RGB"))
    permission = np.asarray(Image.open(output / "merge-permission.png")) == 255
    scope = np.zeros(initial.shape[:2], bool)
    for defect in rejected["defects"]:
        x, y, w, h = (defect[key] for key in ("x", "y", "width", "height"))
        scope[y:y+h, x:x+w] = True
    scope &= permission
    evidence_spec = importlib.util.spec_from_file_location(
        "scope_coverage_evidence", Path(__file__).with_name("source-guided-matte.py"))
    evidence = importlib.util.module_from_spec(evidence_spec)
    evidence_spec.loader.exec_module(evidence)
    alpha = initial[..., 3]
    _, unsupported = evidence.source_contour_evidence(
        source, alpha >= 128, np.zeros(scope.shape, bool), material=True, alpha=alpha)
    missed = (unsupported > 0) & ~scope
    labels, _ = ndimage.label(missed, structure=np.ones((3, 3)))
    regions = []
    for index, box in enumerate(ndimage.find_objects(labels), 1):
        if box is None:
            continue
        ys, xs = box
        regions.append({"x": xs.start, "y": ys.start,
                        "width": xs.stop-xs.start, "height": ys.stop-ys.start,
                        "unsupportedPixels": int(np.count_nonzero(labels[box] == index))})
    report["initialScopeCoverage"] = {
        "unsupportedPixels": int(np.count_nonzero(unsupported)),
        "uncoveredPixels": int(np.count_nonzero(missed)),
        "uncoveredRegions": sorted(regions, key=lambda region: -region["unsupportedPixels"]),
        "diagnosticOnly": True,
    }
    planning_spec = importlib.util.spec_from_file_location(
        "scope_planning", Path(__file__).with_name("repair-scope-planning.py"))
    planning = importlib.util.module_from_spec(planning_spec)
    planning_spec.loader.exec_module(planning)
    report["scopePlanning"] = planning.plan_scope_completion(
        unsupported, permission, rejected["defects"])
(output / "diagnosis.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))
