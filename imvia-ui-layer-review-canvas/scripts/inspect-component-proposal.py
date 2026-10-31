"""Save an offline component proposal and native-source evidence, never a task result."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("attempt")
    parser.add_argument("output", help="New offline directory, never an existing candidate")
    args = parser.parse_args()
    root, output = Path(args.attempt), Path(args.output)
    if output.exists():
        raise ValueError("DIAGNOSTIC_OUTPUT_EXISTS")
    fit = load("component_fit", "component-rgba-registration.py")
    sampler = load("component_sampler", "component-rgba-sampling.py")
    evidence = load("component_evidence", "source-guided-matte.py")
    raw = Image.open(root / "raw.png").convert("RGBA")
    reference = Image.open(root / "standard-reference.png").convert("RGB")
    source = Image.open(root / "selected-crop.png").convert("RGB")
    mapping = json.loads((root / "mapping.json").read_text())
    transforms, anchor, audit = fit.fit_components(reference, raw)
    aligned = sampler.sample_components(raw, transforms, mapping, source.size,
                                        residual_transform=anchor)
    alpha = np.asarray(aligned)[..., 3]
    contour, _ = evidence.source_contour_evidence(
        np.asarray(source), alpha >= 128, np.zeros(alpha.shape, bool),
        material=True, alpha=alpha)
    composed = Image.fromarray(np.dstack((np.asarray(source), alpha)))
    output.mkdir(parents=True, exist_ok=False)
    aligned.save(output / "mapped-native.png")
    composed.save(output / "source-composited.png")
    for name, color in (("dark", "#202020"), ("light", "#f0f0f0")):
        Image.alpha_composite(Image.new("RGBA", composed.size, color), composed).save(output / f"{name}.png")
    # Exercise the actual source-faithful pixel compositor on the already
    # mapped diagnostic. Only this in-memory copy uses selected-region space;
    # the frozen attempt and its processing policy remain unchanged.
    renderer = load("component_renderer", "v2-region-pixels.py")
    diagnostic_manifest = json.loads((root / "manifest.json").read_text())
    diagnostic_manifest["rawCoordinateSpace"] = "selected_region"
    rendered, pixel_audit = renderer.render_region(diagnostic_manifest, output / "mapped-native.png")
    rendered.save(output / "rendered.png")
    for name, color in (("dark", "#202020"), ("light", "#f0f0f0")):
        Image.alpha_composite(Image.new("RGBA", rendered.size, color), rendered).save(output / f"rendered-{name}.png")
    report = {
        "diagnosticOnly": True, "productionChanged": False,
        "rawSha256": hashlib.sha256((root / "raw.png").read_bytes()).hexdigest(),
        "sourceSha256": hashlib.sha256((root / "selected-crop.png").read_bytes()).hexdigest(),
        "coordinateProposal": audit, "sourceContour": contour,
        "sourceRgbPreserved": bool(np.array_equal(np.asarray(composed)[..., :3], np.asarray(source))),
        "opaqueTopology": sampler.topology(alpha >= 128),
        "diagnosticCompositorAudit": pixel_audit,
        "compositorAlphaUnchanged": bool(np.array_equal(np.asarray(rendered)[..., 3], alpha)),
    }
    (output / "diagnosis.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
