import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).with_name("prepare-targeted-imagegen-canvas.py")
SPEC = importlib.util.spec_from_file_location("prepare_targeted_imagegen_canvas", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrepareTargetedImagegenCanvasTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="prepare-imagegen-canvas-test-"))
        self.job_id = "layer-job-test"
        self.job = self.root / self.job_id
        self.job.mkdir()
        self.crop = self.job / "crop.png"
        Image.new("RGBA", (588, 91), (100, 170, 250, 255)).save(self.crop)
        preflight = {
            "layers": [{
                "id": "title-one",
                "execution_route_hint": "codex_rgba",
                "expected_output": {"width": 588, "height": 91},
                "crop_path": str(self.crop),
            }],
        }
        (self.job / "preflight.json").write_text(json.dumps(preflight), encoding="utf-8")

    def tearDown(self):
        for child in sorted(self.root.rglob("*"), reverse=True):
            if child.is_file() or child.is_symlink():
                child.unlink()
            elif child.exists():
                child.rmdir()
        self.root.rmdir()

    def test_prepares_supported_landscape_canvas_and_reversible_mapping(self):
        mapping_path, mapping = MODULE.prepare_canvas(
            self.job_id,
            "title-one",
            jobs_root=self.root,
        )

        self.assertTrue(mapping_path.is_file())
        self.assertEqual(mapping["canvas"], {"width": 1536, "height": 1024})
        region = mapping["content_region"]
        self.assertEqual(region["width"], 1536)
        self.assertLessEqual(abs(region["width"] / region["height"] - 588 / 91), 0.03)
        with Image.open(mapping["reference_path"]) as image:
            self.assertEqual(image.size, (1536, 1024))

    def test_prepares_fixed_targeted_repair_canvas_with_explicit_content_mapping(self):
        preflight_path = self.job / "preflight.json"
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        preflight["layers"][0].update({
            "execution_route_hint": "targeted_repair",
            "expected_output": {"width": 177, "height": 87},
        })
        Image.new("RGBA", (177, 87), (245, 80, 60, 255)).save(self.crop)
        preflight_path.write_text(json.dumps(preflight), encoding="utf-8")

        mapping_path, mapping = MODULE.prepare_canvas(
            self.job_id,
            "title-one",
            jobs_root=self.root,
        )

        self.assertTrue(mapping_path.is_file())
        self.assertEqual(mapping["generated_input_kind"], "targeted_repair_canvas")
        self.assertEqual(mapping["canvas"], {"width": 1536, "height": 1024})
        self.assertEqual(mapping["content_region"], {
            "x": 0,
            "y": 134,
            "width": 1536,
            "height": 755,
        })
        self.assertEqual(mapping["expected_output"], {"width": 177, "height": 87})
        with Image.open(mapping["reference_path"]) as image:
            self.assertEqual(image.size, (1536, 1024))

    def test_result_refinement_reference_preserves_transparent_rgba(self):
        preflight_path = self.job / "preflight.json"
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        preflight["layers"][0].update({
            "execution_route_hint": "result_refinement",
            "transparency_strategy": "preserve_existing_alpha",
            "expected_output": {"width": 4, "height": 2},
            "mask_annotations": [],
        })
        base = Image.new("RGBA", (4, 2), (25, 50, 75, 255))
        base.putpixel((0, 0), (1, 2, 3, 0))
        base.save(self.crop)
        preflight_path.write_text(json.dumps(preflight), encoding="utf-8")

        mapping_path, mapping = MODULE.prepare_canvas(
            self.job_id,
            "title-one",
            jobs_root=self.root,
        )

        self.assertTrue(mapping_path.is_file())
        self.assertEqual(mapping["generated_input_kind"], "result_refinement_canvas")
        self.assertEqual(mapping["execution_route"], "result_refinement")
        self.assertEqual(mapping["base_png_dimensions"], {"width": 4, "height": 2})
        self.assertEqual(mapping["content_region"], {
            "x": 0,
            "y": 128,
            "width": 1536,
            "height": 768,
        })
        with Image.open(mapping["reference_path"]) as reference:
            self.assertEqual(reference.format, "PNG")
            self.assertEqual(reference.mode, "RGBA")
            self.assertEqual(reference.size, (1536, 1024))
            self.assertEqual(reference.getpixel((0, 0)), (0, 0, 0, 0))
            self.assertLess(reference.getpixel((64, 192))[3], 255)

    def test_rejects_non_codex_rgba_route(self):
        preflight_path = self.job / "preflight.json"
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        preflight["layers"][0]["execution_route_hint"] = "alpha_extract"
        preflight_path.write_text(json.dumps(preflight), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "only valid for codex_rgba, targeted_repair, or result_refinement"):
            MODULE.prepare_canvas(self.job_id, "title-one", jobs_root=self.root)


if __name__ == "__main__":
    unittest.main()
