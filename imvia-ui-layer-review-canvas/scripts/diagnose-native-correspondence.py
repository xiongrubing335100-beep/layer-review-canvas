"""Read-only correspondence probe; does not generate/finalize/edit any image."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--attempt", required=True)
parser.add_argument("--initial-matrix", required=True)
parser.add_argument("--affine-anchor", action="store_true",
                    help="In-memory hypothesis only; leave source file unchanged.")
parser.add_argument("--alpha-corners", action="store_true",
                    help="Detect physical silhouette corners, not thin edge-map ridges.")
parser.add_argument("--corner-spacing", type=int, default=8)
args = parser.parse_args()
root = Path(args.attempt)
source = np.asarray(Image.open(root / "standard-reference.png").convert("RGB"))
alpha = np.asarray(Image.open(root / "raw.png").convert("RGBA"))[..., 3]
source_edges = np.zeros(alpha.shape, np.uint8)
for channel in cv2.split(source):
    source_edges |= cv2.Canny(channel, 25, 70)
source_edges = cv2.GaussianBlur(source_edges, (0, 0), 1)
generated_edges = cv2.GaussianBlur(cv2.Canny(alpha, 25, 70), (0, 0), 1)
corner_image = cv2.GaussianBlur(alpha, (0, 0), 1) if args.alpha_corners else generated_edges
points = cv2.goodFeaturesToTrack(corner_image, maxCorners=1500,
                               qualityLevel=.01, minDistance=args.corner_spacing)
matrix = np.asarray(json.loads(args.initial_matrix), dtype=np.float32)
parameters = dict(winSize=(25, 25), maxLevel=2,
                  criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, .01),
                  flags=cv2.OPTFLOW_USE_INITIAL_FLOW)
forward, found, error = cv2.calcOpticalFlowPyrLK(
    generated_edges, source_edges, points, cv2.transform(points, matrix), **parameters)
back, found_back, _ = cv2.calcOpticalFlowPyrLK(
    source_edges, generated_edges, forward, points.copy(), **parameters)
round_trip = np.linalg.norm(back - points, axis=2).ravel()
keep = ((found.ravel() > 0) & (found_back.ravel() > 0)
        & (round_trip < 1) & (error.ravel() < 20))
spec = importlib.util.spec_from_file_location("diagnostic_local",
    Path(__file__).with_name("native-local-registration.py"))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)
if args.affine_anchor:
    experimental_source = Path(spec.origin).read_text().replace(
        "cv2.estimateAffinePartial2D(p,q,", "cv2.estimateAffine2D(p,q,")
    exec(compile(experimental_source, spec.origin, "exec"), local.__dict__)
failure_state = {}


def trace(frame, event, arg):
    if frame.f_code is local.fit_local_map.__code__ and event == "exception":
        state = frame.f_locals
        failure_state["line"] = frame.f_lineno
        failure_state["remainingCorrespondences"] = len(state.get("q", []))
        if "matrix" in state and state["matrix"] is not None:
            failure_state["globalAnchor"] = state["matrix"].tolist()
        if "q" in state and len(state["q"]):
            failure_state["sourceSpan"] = np.ptp(state["q"], axis=0).tolist()
    return trace


report = {"diagnosticOnly": True, "initialCorners": len(points),
          "affineAnchorHypothesis": args.affine_anchor,
          "alphaCorners": args.alpha_corners,
          "cornerSpacing": args.corner_spacing,
          "reciprocalCorrespondences": int(keep.sum()),
          "roundTripQuantiles": np.quantile(round_trip, [.25, .5, .75]).tolist(),
          "errorQuantiles": np.quantile(error, [.25, .5, .75]).tolist()}
sys.settrace(trace)
try:
    _, report["audit"] = local.fit_local_map(
        points[:, 0][keep], forward[:, 0][keep], (alpha.shape[1], alpha.shape[0]))
except ValueError as exc:
    report.update({"error": str(exc), "failureState": failure_state})
finally:
    sys.settrace(None)
print(json.dumps(report, indent=2))
