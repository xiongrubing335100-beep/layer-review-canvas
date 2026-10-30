"""Read-only archived replay: capture final-grid contacts at topology rejection."""
import json
from pathlib import Path
import runpy
import sys

import cv2
import numpy as np
from PIL import Image

attempt, output = sys.argv[1:]
captured = []


def trace(frame, event, arg):
    if (event == "exception" and frame.f_code.co_name == "sample_components"
            and "combined active=" in str(arg[1])):
        values = frame.f_locals
        registration = frame.f_globals["registration"]
        masks, coverages = {}, {}
        for index in values["active"]:
            component = values["values"].copy()
            component[values["owners"] != index] = 0
            sampled = np.asarray(registration.sample_aligned(
                Image.fromarray(component), np.asarray(values["transforms"][index-1]),
                values["mapping"], values["expected_size"]))
            coverages[index] = sampled[..., 3].astype(np.float64)
            masks[index] = sampled[..., 3] >= 128
        contacts = []
        for left in masks:
            for right in masks:
                if right <= left:
                    continue
                touching = (cv2.dilate(masks[left].astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & masks[right]
                soft_bridge = ((coverages[left] + coverages[right] >= 128)
                               & ~masks[left] & ~masks[right])
                for kind, mask in (("opaque-adjacency", touching), ("soft-coverage-sum", soft_bridge)):
                    y, x = np.where(mask)
                    if len(x):
                        contacts.append({"pair": [left, right], "kind": kind,
                                         "pixels": len(x),
                                         "bounds": [int(x.min()), int(y.min()), int(x.max()), int(y.max())],
                                         "coordinates": np.stack((x, y), axis=1).tolist()})
        captured.append({"error": str(arg[1]), "contacts": contacts,
                         "transforms": values["transforms"],
                         "residualTransform": values["residual_transform"],
                         "mapping": values["mapping"],
                         "size": values["expected_size"]})
    return trace


sys.argv = ["inspect-scoped-repair-offline.py", attempt, output]
sys.settrace(trace)
try:
    runpy.run_path(str(Path(__file__).with_name("inspect-scoped-repair-offline.py")), run_name="__main__")
finally:
    sys.settrace(None)
Path(output, "contacts.json").write_text(json.dumps(captured, indent=2, default=lambda x: x.tolist()))
print(json.dumps({"captures": len(captured), "contacts": [x["contacts"] for x in captured]}))
