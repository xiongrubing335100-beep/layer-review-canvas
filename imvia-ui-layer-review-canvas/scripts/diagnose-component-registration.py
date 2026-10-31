"""Read-only component registration feasibility probe. No delivery or file writes."""
import argparse
import json
import importlib.util
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from scipy.optimize import minimize, differential_evolution
from scipy import ndimage

parser = argparse.ArgumentParser()
parser.add_argument("attempt")
parser.add_argument("--initial-matrix", help="Optional diagnostic anchor, otherwise fit from identity.")
parser.add_argument("--joint", action="store_true", help="Constrain candidate blocks against already placed opaque blocks.")
parser.add_argument("--output", help="New diagnostic directory; never a formal candidate.")
args = parser.parse_args()
root = Path(args.attempt)
raw = np.asarray(Image.open(root / "raw.png").convert("RGBA"))
source = np.asarray(Image.open(root / "standard-reference.png").convert("RGB"))
edges = np.zeros(raw.shape[:2], np.uint8)
for channel in cv2.split(source):
    edges |= cv2.Canny(channel, 25, 70)
distance = cv2.distanceTransform(255-edges, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
count, labels, stats, centers = cv2.connectedComponentsWithStats((raw[..., 3] >= 128).astype(np.uint8))
nearest = ndimage.distance_transform_edt(labels == 0, return_distances=False, return_indices=True)
owners = labels[tuple(nearest)]
all_contours, _ = cv2.findContours((raw[..., 3] >= 128).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
all_points = np.concatenate(all_contours)[:, 0].astype(np.float32)
if args.initial_matrix:
    initial = np.asarray(json.loads(args.initial_matrix), dtype=np.float64)
else:
    def global_score(parameters):
        transform = np.array([[parameters[0], parameters[1], parameters[4]],
                              [parameters[2], parameters[3], parameters[5]]], np.float32)
        q = cv2.transform(all_points[None], transform)[0]
        values = cv2.remap(distance, q[:, 0, None], q[:, 1, None], cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=100)
        return np.minimum(values, 20).mean()
    bounds = [(.85, 1.15), (-.04, .04), (-.04, .04), (.85, 1.15), (-80, 80), (-80, 80)]
    coarse = differential_evolution(global_score, bounds, seed=2718, popsize=8,
                                    maxiter=100, polish=False)
    fit = minimize(global_score, coarse.x, method="Powell", bounds=bounds,
                   options={"maxiter": 120, "xtol": .0001, "ftol": .0001})
    p = fit.x
    initial = np.array([[p[0], p[1], p[4]], [p[2], p[3], p[5]]])
merged = np.zeros(raw.shape[:2], np.uint8)
reports = []
transforms = []
for index in range(1, count):
    mask = (labels == index).astype(np.uint8)*255
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    points = np.concatenate(contours)[:, 0].astype(np.float32)
    center = centers[index]
    def matrix(parameters):
        linear = initial[:, :2] + np.array(parameters[:4]).reshape(2, 2)
        return np.column_stack((linear, initial[:, 2] + parameters[4:] - (linear-initial[:, :2])@center))
    def residual(parameters):
        q = cv2.transform(points[None], matrix(parameters).astype(np.float32))[0]
        return cv2.remap(distance, q[:, 0, None], q[:, 1, None], cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=100).ravel()
    forbidden = cv2.dilate((merged >= 128).astype(np.uint8), np.ones((3, 3), np.uint8))
    penetration = cv2.distanceTransform(forbidden, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    sy, sx = np.where(mask[::4, ::4] > 0)
    support_points = np.concatenate((points, np.stack((sx*4, sy*4), axis=1))).astype(np.float32)
    def score(parameters):
        value = np.minimum(residual(parameters), 20).mean()
        if args.joint and forbidden.any():
            q = cv2.transform(support_points[None], matrix(parameters).astype(np.float32))[0]
            collision = cv2.remap(penetration, q[:, 0, None], q[:, 1, None], cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=100)
            value += 5*collision.max()
        return value
    shift_limit = min(40., max(4., .2*min(stats[index, 2:4])))
    fit = minimize(score, np.zeros(6),
                   method="Powell", bounds=[(-.08, .08)]*4+[(-shift_limit, shift_limit)]*2,
                   options={"maxiter": 120, "xtol": .0001, "ftol": .0001})
    transforms.append(matrix(fit.x))
    # Keep original antialias/partial coverage; binary masks are only fit geometry.
    component_alpha = np.where(owners == index, raw[..., 3], 0).astype(np.uint8)
    mapped = cv2.warpAffine(component_alpha, matrix(fit.x), (raw.shape[1], raw.shape[0]))
    merged = np.maximum(merged, mapped)
    error = residual(fit.x)
    reports.append({"component": index, "bounds": stats[index].tolist(),
                    "matrix": matrix(fit.x).tolist(),
                    "meanEdgeDistance": float(error.mean()), "p95EdgeDistance": float(np.quantile(error, .95)),
                    "fitObjective": float(score(fit.x)),
                    "initialObjective": float(score(np.zeros(6))),
                    "opaqueOverlapReferencePixels": int(np.count_nonzero((mapped >= 128) & (forbidden > 0)))})
spec = importlib.util.spec_from_file_location("evidence", Path(__file__).with_name("source-guided-matte.py"))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)
mapping = json.loads((root / "mapping.json").read_text())
region = mapping["contentRegion"]
original = np.asarray(Image.open(root / "selected-crop.png").convert("RGB"))
cropped = merged[region["y"]:region["y"]+region["height"], region["x"]:region["x"]+region["width"]]
native = cv2.resize(cropped, (original.shape[1], original.shape[0]), interpolation=cv2.INTER_AREA)
audit, _ = evidence.source_contour_evidence(original, native >= 128,
    np.zeros(native.shape, bool), material=True, alpha=native)
sampling_spec = importlib.util.spec_from_file_location("component_sampling", Path(__file__).with_name("component-rgba-sampling.py"))
sampling = importlib.util.module_from_spec(sampling_spec)
sampling_spec.loader.exec_module(sampling)
try:
    exact = np.asarray(sampling.sample_components(Image.fromarray(raw), transforms, mapping,
                                                 (original.shape[1], original.shape[0]),
                                                 residual_transform=initial))
    sampling_report, _ = evidence.source_contour_evidence(original, exact[..., 3] >= 128,
        np.zeros(native.shape, bool), material=True, alpha=exact[..., 3])
    if args.output:
        output = Path(args.output)
        output.mkdir(parents=True, exist_ok=False)
        # Source-composited view is diagnostic only; it performs no RGB repair.
        combined = Image.fromarray(np.dstack((original, exact[..., 3])))
        combined.save(output / "source-composited.png")
        Image.fromarray(exact).save(output / "mapped-native.png")
        for name, color in (("dark", (32, 32, 32, 255)), ("light", (240, 240, 240, 255))):
            Image.alpha_composite(Image.new("RGBA", combined.size, color), combined).save(output / f"{name}.png")
        (output / "diagnosis.json").write_text(json.dumps({
            "diagnosticOnly": True, "productionChanged": False, "sourceContour": sampling_report,
            "initialMatrix": initial.tolist(), "componentTransforms": [m.tolist() for m in transforms],
            "jointConstraints": args.joint}, indent=2))
except ValueError as error:
    sampling_report = {"error": str(error)}
print(json.dumps({"diagnosticOnly": True, "initialMatrix": initial.tolist(),
                  "componentFits": reports, "sourceContour": audit,
                  "wholeRgbaSampling": sampling_report}, indent=2))
