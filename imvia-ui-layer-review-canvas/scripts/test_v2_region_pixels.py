import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from PIL import Image


SCRIPT = Path(__file__).with_name("v2-region-pixels.py")


class V2RegionPixelTests(unittest.TestCase):
    def run_cli(self, manifest, raw, output, matte=None):
        command = [str(__import__("sys").executable), str(SCRIPT), "--manifest", str(manifest), "--raw", str(raw), "--output", str(output)]
        if matte is not None:
            command += ["--matte", str(matte)]
        return subprocess.run(command, check=False, text=True, capture_output=True)

    def test_extract_retains_frozen_crop_rgb_alpha_and_original_placement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = Image.new("RGBA", (4, 3), (20, 90, 180, 255))
            matte = Image.new("RGBA", (6, 6), (0, 0, 0, 255))
            matte.putpixel((2, 2), (255, 255, 255, 255))
            raw = root / "matte.png"; matte.save(raw)
            matte_path = root / "matte.png"
            crop = root / "crop.png"; base.crop((1, 1, 3, 3)).save(crop)
            report = root / "report.json"
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
                "selectedCropPath": str(crop), "outputPath": str(root / "out.png"), "reportPath": str(report),
                "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 2, "height": 2}, "strategy": {"repairPaths": []}},
                "mapping": {"canvas": {"width": 6, "height": 6}, "contentRegion": {"x": 2, "y": 2, "width": 2, "height": 2}, "sourceRegion": {"width": 2, "height": 2}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, raw, root / "out.png", matte_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(root / "out.png").convert("RGBA")
            self.assertEqual(output.size, (2, 2))
            self.assertEqual(output.getpixel((0, 0))[:3], base.getpixel((1, 1))[:3])
            self.assertEqual(output.getpixel((0, 0))[3], 255)
            self.assertEqual(output.getpixel((1, 1))[3], 0)
            report_data = json.loads(report.read_text())
            self.assertEqual(report_data["placement"], {"x": 129, "y": 1522})
            self.assertEqual(report_data["rgbSource"], "frozen_crop")

    def test_reconstruction_cannot_change_pixels_outside_authorized_repair_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = Image.new("RGBA", (8, 6), (10, 20, 30, 255)); crop_path = root / "crop.png"; crop.save(crop_path)
            raw_path = root / "generated.png"; Image.new("RGBA", (8, 6), (210, 110, 20, 255)).save(raw_path)
            manifest = {"schemaVersion": 2, "route": "reconstruct", "maskProvider": "generated_region", "removeBackground": False,
                "selectedCropPath": str(crop_path), "snapshot": {"bounds": {"x": 40, "y": 70, "width": 8, "height": 6},
                "strategy": {"repairPaths": [{"kind": "include", "closed": True, "anchors": [{"x": 41, "y": 71, "in": {"x": 41, "y": 71}, "out": {"x": 41, "y": 71}}, {"x": 44, "y": 71, "in": {"x": 44, "y": 71}, "out": {"x": 44, "y": 71}}, {"x": 44, "y": 74, "in": {"x": 44, "y": 74}, "out": {"x": 44, "y": 74}}, {"x": 41, "y": 74, "in": {"x": 41, "y": 74}, "out": {"x": 41, "y": 74}}]}]}},
                "outputPath": str(root / "out.png")}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, raw_path, root / "out.png")
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(root / "out.png").convert("RGBA")
            self.assertEqual(output.getpixel((0, 0)), (10, 20, 30, 255))
            self.assertEqual(output.getpixel((2, 2)), (210, 110, 20, 255))

    def test_padded_imagegen_matte_requires_inverse_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = root / "crop.png"; Image.new("RGBA", (2, 2), (10, 20, 30, 255)).save(crop)
            matte = root / "matte.png"; Image.new("RGB", (6, 6), "white").save(matte)
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
                "selectedCropPath": str(crop), "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 2, "height": 2}, "strategy": {"repairPaths": []}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            raw_path = root / "raw.png"; Image.new("RGBA", (2, 2), "white").save(raw_path)
            result = self.run_cli(manifest_path, raw_path, root / "out.png", matte)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("MAPPING_REQUIRED_FOR_PADDED_MATTE", result.stderr)

    def test_padded_reconstruction_inverse_maps_only_the_reference_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = root / "crop.png"; Image.new("RGBA", (2, 2), (10, 20, 30, 255)).save(crop)
            raw = Image.new("RGBA", (6, 6), (0, 0, 0, 255))
            for y in range(2, 4):
                for x in range(2, 4): raw.putpixel((x, y), (230, 80, 30, 255))
            raw_path = root / "generated.png"; raw.save(raw_path)
            mapping = {"canvas": {"width": 6, "height": 6}, "contentRegion": {"x": 2, "y": 2, "width": 2, "height": 2},
                "sourceRegion": {"width": 2, "height": 2}}
            mapping_path = root / "mapping.json"; mapping_path.write_text(json.dumps(mapping))
            manifest = {"schemaVersion": 2, "route": "reconstruct", "maskProvider": "generated_region", "removeBackground": False,
                "selectedCropPath": str(crop), "mappingPath": str(mapping_path), "outputRoot": str(root),
                "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 2, "height": 2}, "strategy": {"repairPaths": []}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, raw_path, root / "out.png")
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(root / "out.png").convert("RGBA")
            self.assertEqual(output.getpixel((0, 0)), (230, 80, 30, 255))

    def test_transparent_and_fully_opaque_background_removal_are_not_false_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop_path = root / "crop.png"; Image.new("RGBA", (2, 2), (10, 20, 30, 255)).save(crop_path)
            raw_path = root / "candidate.png"; Image.new("RGBA", (2, 2), (210, 110, 20, 255)).save(raw_path)
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "bria", "removeBackground": True,
                "selectedCropPath": str(crop_path), "snapshot": {"bounds": {"x": 5, "y": 9, "width": 2, "height": 2}, "strategy": {"repairPaths": []}}, "outputPath": str(root / "out.png")}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            matte = root / "matte.png"; Image.new("RGBA", (2, 2), (0, 0, 0, 0)).save(matte)
            failed = self.run_cli(manifest_path, raw_path, root / "transparent.png", matte)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("ALL_TRANSPARENT", failed.stderr)
            matte = root / "opaque.png"; Image.new("RGBA", (2, 2), (255, 255, 255, 255)).save(matte)
            opaque = self.run_cli(manifest_path, raw_path, root / "opaque-output.png", matte)
            self.assertEqual(opaque.returncode, 0, opaque.stderr)
            self.assertEqual(json.loads(opaque.stdout)["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
