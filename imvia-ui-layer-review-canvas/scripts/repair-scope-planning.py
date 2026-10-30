"""Read-only scope suggestions; never authorize repairs or classify semantics."""
import numpy as np
from scipy import ndimage


def plan_scope_completion(unsupported, permission, defects):
    unsupported = np.asarray(unsupported) > 0
    permission = np.asarray(permission, dtype=bool)
    if unsupported.shape != permission.shape or unsupported.ndim != 2:
        raise ValueError("SCOPE_PLANNING_DIMENSIONS")
    height, width = unsupported.shape
    covered = np.zeros(unsupported.shape, bool)
    area = 0
    for defect in defects:
        x, y, w, h = (defect[key] for key in ("x", "y", "width", "height"))
        if (not all(type(v) is int for v in (x, y, w, h))
                or min(x, y) < 0 or min(w, h) < 1 or x+w > width or y+h > height):
            raise ValueError("INVALID_DEFECT_SCOPE")
        covered[y:y+h, x:x+w] = True
        area += w*h
    covered &= permission
    labels, _ = ndimage.label(unsupported, structure=np.ones((3, 3)))
    suggestions = []
    blocked = 0
    for index, box in enumerate(ndimage.find_objects(labels), 1):
        if box is None:
            continue
        component = labels[box] == index
        # Use the complete connected run, not fragments remaining after
        # subtracting existing rectangles. Four pixels are inspection context,
        # not a claim that the eventual generated edge will join correctly.
        size = int(component.sum())
        if size <= 12 or not np.any(component & ~covered[box]):
            continue
        blocked += int(np.count_nonzero(component & ~permission[box]))
        ys, xs = box
        x, y = max(0, xs.start-4), max(0, ys.start-4)
        right, bottom = min(width, xs.stop+4), min(height, ys.stop+4)
        suggestions.append({"x": x, "y": y, "width": right-x,
                            "height": bottom-y, "unsupportedPixels": size})
        area += (right-x)*(bottom-y)
    within = len(defects)+len(suggestions) <= 16 and area <= width*height*.25
    return {"suggestedRegions": suggestions, "summedArea": area,
            "withinBudget": within, "blockedPixels": blocked,
            "canCoverBlockingRuns": within and blocked == 0,
            "requiresSourceInspection": True}


if __name__ == "__main__":
    import argparse
    import hashlib
    import importlib.util
    import json
    from pathlib import Path
    from PIL import Image

    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("initial", "source", "permission", "manifest", "raw"):
        parser.add_argument("--"+name)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    if args.manifest:
        if not args.raw or any((args.initial, args.source, args.permission)):
            parser.error("manifest mode requires raw and forbids substituted source/preview")
        manifest = json.loads(Path(args.manifest).read_text())
        strategy = manifest.get("snapshot", {}).get("strategy", {})
        if (manifest.get("maskProvider") != "native_rgba" or manifest.get("scopedNativeRepair")
                or manifest.get("maximumImagegenCalls") != 2
                or strategy.get("localRepairPolicy") != "scoped_once_v1"):
            raise ValueError("REPAIR_BUDGET_NOT_AUTHORIZED")
        renderer_spec = importlib.util.spec_from_file_location(
            "scope_renderer", Path(__file__).with_name("v2-region-pixels.py"))
        renderer = importlib.util.module_from_spec(renderer_spec)
        renderer_spec.loader.exec_module(renderer)
        raw = renderer.inside_root(manifest["outputRoot"], args.raw)
        image, _ = renderer.render_region(manifest, raw, _defer_component_contour=True)
        initial = np.asarray(image)
        source = np.asarray(Image.open(renderer.inside_root(
            manifest["outputRoot"], manifest["selectedCropPath"])).convert("RGB"))
        snapshot = manifest["snapshot"]
        allowed = renderer.path_mask(snapshot.get("paths", []), snapshot["bounds"])
        if strategy.get("repairPaths"):
            allowed = Image.fromarray(np.minimum(np.asarray(allowed), np.asarray(
                renderer.path_mask(strategy["repairPaths"], snapshot["bounds"]))))
        permission = np.asarray(allowed) == 255
    else:
        if not all((args.initial, args.source, args.permission)) or args.raw:
            parser.error("diagnostic mode requires initial, source and permission")
        initial = np.asarray(Image.open(args.initial).convert("RGBA"))
        source = np.asarray(Image.open(args.source).convert("RGB"))
        permission = np.asarray(Image.open(args.permission).convert("L")) == 255
    if source.shape[:2] != initial.shape[:2] or permission.shape != initial.shape[:2]:
        raise ValueError("SCOPE_PLANNING_DIMENSIONS")
    spec = importlib.util.spec_from_file_location(
        "scope_source_evidence", Path(__file__).with_name("source-guided-matte.py"))
    evidence = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evidence)
    alpha = initial[..., 3]
    contour, unsupported = evidence.source_contour_evidence(
        source, alpha >= 128, np.zeros(alpha.shape, bool), material=True, alpha=alpha)
    report = json.loads(Path(args.report).read_text())
    plan = plan_scope_completion(unsupported, permission, report["defects"])
    print(json.dumps({
        **plan, "sourceContour": contour,
        "initialRgbaSha256": hashlib.sha256(initial.tobytes()).hexdigest(),
        "sourceRgbSha256": hashlib.sha256(source.tobytes()).hexdigest(),
        "diagnosticOnly": True,
    }))
