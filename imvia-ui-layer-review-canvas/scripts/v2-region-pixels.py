#!/usr/bin/env python3
"""Deterministic V2 selected-region PNG finalizer; no model or network calls."""
import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def fail(code, message=None):
    raise ValueError(f"{code}: {message or code}")


def inside_root(root, target):
    root = Path(root).resolve()
    target = Path(target).resolve()
    if root != target and root not in target.parents:
        fail("PATH_ESCAPES_ROOT", str(target))
    return target


def bezier_points(path):
    anchors = path.get("anchors", [])
    if len(anchors) < 3 or not path.get("closed"):
        fail("INVALID_CLOSED_PATH")
    points = []
    for index, start in enumerate(anchors):
        end = anchors[(index + 1) % len(anchors)]
        p0 = (float(start["x"]), float(start["y"]))
        p1 = tuple(float(value) for value in start["out"].values())
        p2 = tuple(float(value) for value in end["in"].values())
        p3 = (float(end["x"]), float(end["y"]))
        for step in range(12):
            t = step / 12
            u = 1 - t
            points.append((u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                           u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]))
    return points


def path_mask(paths, bounds):
    width, height = bounds["width"], bounds["height"]
    included = [path for path in paths if path.get("kind") == "include"]
    excluded = [path for path in paths if path.get("kind") == "exclude"]
    mask = Image.new("L", (width, height), 255 if not included else 0)
    draw = ImageDraw.Draw(mask)
    for item in included:
        draw.polygon([(x-bounds["x"], y-bounds["y"]) for x, y in bezier_points(item)], fill=255)
    for item in excluded:
        draw.polygon([(x-bounds["x"], y-bounds["y"]) for x, y in bezier_points(item)], fill=0)
    return mask


def matte_mask(path, mapping, expected_size, provider):
    matte = Image.open(path)
    if matte.width * matte.height > 40_000_000:
        fail("MATTE_TOO_LARGE")
    rgba = matte.convert("RGBA")
    if provider == "imagegen_matte":
        mask = Image.new("L", expected_size, 0)
        region = mapping.get("contentRegion") if mapping else None
        source_region = mapping.get("sourceRegion") if mapping else None
        canvas = mapping.get("canvas") if mapping else None
        if region and source_region and canvas and (matte.width, matte.height) == (canvas["width"], canvas["height"]):
            if (source_region["width"], source_region["height"]) != expected_size:
                fail("MAPPING_SOURCE_SIZE_MISMATCH")
            pixels = rgba.load(); output = mask.load()
            for y in range(expected_size[1]):
                sy = region["y"] + min(region["height"] - 1, math.floor((y + 0.5) * region["height"] / expected_size[1]))
                for x in range(expected_size[0]):
                    sx = region["x"] + min(region["width"] - 1, math.floor((x + 0.5) * region["width"] / expected_size[0]))
                    red, green, blue, _ = pixels[sx, sy]
                    output[x, y] = round((red * 0.2126 + green * 0.7152 + blue * 0.0722))
            return mask
        if rgba.size != expected_size:
            fail("MAPPING_REQUIRED_FOR_PADDED_MATTE")
        return rgba.convert("RGB").convert("L")
    if rgba.size != expected_size:
        fail("MATTE_DIMENSIONS_MISMATCH")
    alpha = rgba.getchannel("A")
    if alpha.getextrema() == (255, 255):
        rgb_luma = rgba.convert("RGB").convert("L")
        if rgb_luma.getextrema() != (255, 255):
            return rgb_luma
    return alpha


def inverse_mapped_region(image, mapping, expected_size):
    if not mapping or not mapping.get("contentRegion") or not mapping.get("canvas") or not mapping.get("sourceRegion"):
        fail("MAPPING_REQUIRED_FOR_PADDED_IMAGE")
    if (mapping["sourceRegion"]["width"], mapping["sourceRegion"]["height"]) != expected_size:
        fail("MAPPING_SOURCE_SIZE_MISMATCH")
    canvas = mapping["canvas"]
    region = mapping["contentRegion"]
    if region["x"] + region["width"] > canvas["width"] or region["y"] + region["height"] > canvas["height"]:
        fail("INVALID_REFERENCE_MAPPING")
    if image.size != (canvas["width"], canvas["height"]):
        fail("MAPPING_CANVAS_SIZE_MISMATCH")
    source = image.load()
    width, height = expected_size
    result = Image.new("RGBA", expected_size)
    target = result.load()
    for y in range(height):
        sy = region["y"] + min(region["height"] - 1, math.floor((y + 0.5) * region["height"] / height))
        for x in range(width):
            sx = region["x"] + min(region["width"] - 1, math.floor((x + 0.5) * region["width"] / width))
            target[x, y] = source[sx, sy]
    return result


def alpha_state(alpha, remove_background):
    low, high = alpha.getextrema()
    if high == 0:
        fail("ALL_TRANSPARENT")
    status = "needs_review" if remove_background and low == 255 and high == 255 else "candidate"
    return {"min": low, "max": high, "status": status}


def run(args):
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 2 or manifest.get("route") not in ("extract_mask", "reconstruct"):
        fail("INVALID_PROCESSING_MANIFEST")
    snapshot = manifest.get("snapshot") or {}
    bounds = snapshot.get("bounds") or {}
    width, height = bounds.get("width"), bounds.get("height")
    if not all(isinstance(value, int) and value > 0 for value in (width, height)):
        fail("INVALID_REGION_BOUNDS")
    root = Path(manifest.get("outputRoot", manifest_path.parent.parent)).resolve()
    output_path = inside_root(root, args.output)
    crop_path = inside_root(root, manifest["selectedCropPath"])
    raw_path = inside_root(root, args.raw)
    matte_path = inside_root(root, args.matte) if args.matte else None
    mapping_path = inside_root(root, manifest["mappingPath"]) if manifest.get("mappingPath") else None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    base = Image.open(crop_path).convert("RGBA")
    if base.size != (width, height):
        fail("SELECTED_CROP_DIMENSIONS_MISMATCH")
    raw = Image.open(raw_path).convert("RGBA")
    if manifest["route"] == "reconstruct" and raw.size != (width, height):
        mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path else manifest.get("mapping")
        raw = inverse_mapped_region(raw, mapping, (width, height))
    if manifest["route"] == "extract_mask":
        if manifest.get("maskProvider") == "selection":
            mask = path_mask(snapshot.get("paths", []), bounds)
        elif manifest.get("removeBackground"):
            matte_path = matte_path or (raw_path if manifest.get("maskProvider") == "imagegen_matte" else None)
            if not matte_path:
                fail("MATTE_REQUIRED")
            mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path else manifest.get("mapping")
            mask = matte_mask(matte_path, mapping, (width, height), manifest.get("maskProvider"))
            path_limit = path_mask(snapshot.get("paths", []), bounds)
            mask = Image.frombytes("L", mask.size, bytes(min(a, b) for a, b in zip(mask.tobytes(), path_limit.tobytes())))
        else:
            matte_path = matte_path
            if not matte_path:
                fail("MATTE_REQUIRED")
            mask = matte_mask(matte_path, None, (width, height), manifest.get("maskProvider"))
        result = base.copy()
        result.putalpha(Image.frombytes("L", (width, height), bytes(round(a * b / 255) for a, b in zip(base.getchannel("A").tobytes(), mask.tobytes()))))
        rgb_source = "frozen_crop"
    else:
        allowed = path_mask(snapshot.get("strategy", {}).get("repairPaths", []), bounds)
        if manifest.get("removeBackground"):
            if not matte_path:
                fail("MATTE_REQUIRED")
            mapping = json.loads(mapping_path.read_text(encoding="utf-8")) if mapping_path else manifest.get("mapping")
            alpha = matte_mask(matte_path, mapping, (width, height), manifest.get("maskProvider"))
        else:
            alpha = raw.getchannel("A")
        original = base.load(); generated = raw.load(); alpha_pixels = alpha.load(); allowed_pixels = allowed.load()
        result = base.copy(); result_pixels = result.load()
        for y in range(height):
            for x in range(width):
                if allowed_pixels[x, y]:
                    result_pixels[x, y] = (*generated[x, y][:3], alpha_pixels[x, y])
        rgb_source = "generated_inside_repair_mask"
    alpha_info = alpha_state(result.getchannel("A"), bool(manifest.get("removeBackground")))
    if output_path.exists():
        fail("OUTPUT_ALREADY_EXISTS")
    result.save(output_path, format="PNG", optimize=False)
    audit = {"status": alpha_info["status"], "width": width, "height": height, "placement": {"x": bounds["x"], "y": bounds["y"]},
        "alpha": alpha_info, "rgbSource": rgb_source, "route": manifest["route"], "maskProvider": manifest.get("maskProvider")}
    if manifest.get("reportPath"):
        Path(manifest["reportPath"]).write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return audit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--raw", required=True)
    parser.add_argument("--matte")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as error:  # CLI contract emits a machine-readable failure code on stderr.
        message = str(error)
        print(message, file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
