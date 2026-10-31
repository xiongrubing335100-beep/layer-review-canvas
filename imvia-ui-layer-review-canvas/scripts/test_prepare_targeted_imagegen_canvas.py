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


ROI_POLICY = {
    "strategy": "per_repair_path_native_tiles",
    "scale_mode": "native_1_to_1",
    "context_padding_ratio": 0.08,
    "minimum_padding_ratio": 0.03,
    "maximum_padding_ratio": 0.15,
    "warn_coverage_ratio": 0.4,
    "block_coverage_ratio": 0.7,
    "tile_overlap_pixels": 32,
}


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

    def test_codex_rgba_repair_prepares_a_mapped_scope_mask_and_sequential_stage_policy(self):
        preflight_path = self.job / "preflight.json"
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        preflight["layers"][0].update({
            "execution_route_hint": "codex_rgba_repair",
            "expected_output": {"width": 588, "height": 91},
            "repair_regions": [{"shape": "rect", "x": 50, "y": 10, "width": 100, "height": 20}],
            "repair_region_source": "submitted_annotation",
        })
        preflight_path.write_text(json.dumps(preflight), encoding="utf-8")

        mapping_path, mapping = MODULE.prepare_canvas(
            self.job_id,
            "title-one",
            jobs_root=self.root,
        )

        self.assertTrue(mapping_path.is_file())
        scope_path = Path(mapping["repair_scope_path"])
        self.assertTrue(scope_path.is_file())
        self.assertEqual(mapping["stage_reference_policy"], {
            "repair_rgb": ["reference_path", "repair_scope_path"],
            "alpha_matte": ["accepted_repair_rgb_path"],
        })
        region = mapping["content_region"]
        expected_x = region["x"] + round(50 * region["width"] / 588)
        expected_y = region["y"] + round(10 * region["height"] / 91)
        with Image.open(scope_path) as scope:
            self.assertEqual(scope.size, (1536, 1024))
            self.assertGreater(scope.convert("L").getpixel((expected_x + 5, expected_y + 5)), 239)
            self.assertLess(scope.convert("L").getpixel((0, 0)), 16)

    def test_result_refinement_reference_preserves_transparent_rgba(self):
        preflight_path = self.job / "preflight.json"
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        preflight["layers"][0].update({
            "execution_route_hint": "result_refinement",
            "transparency_strategy": "preserve_existing_alpha",
            "expected_output": {"width": 4, "height": 2},
            "refinement_operation": {
                "mode": "full_canvas_explicit",
                "subject_path_ids": [],
                "alpha_include_path_ids": [],
            },
            "roi_policy": dict(ROI_POLICY),
            "repair_path_ids": [],
            "expected_roi_tile_count": 1,
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
        self.assertEqual(mapping["version"], 2)
        self.assertEqual(mapping["generated_input_kind"], "result_refinement_roi_manifest")
        self.assertEqual(mapping["execution_route"], "result_refinement")
        self.assertEqual(mapping["base_png_dimensions"], {"width": 4, "height": 2})
        self.assertEqual(len(mapping["roi_jobs"]), 1)
        roi_job = mapping["roi_jobs"][0]
        self.assertEqual(roi_job["base_region"], {
            "x": 0,
            "y": 0,
            "width": 4,
            "height": 2,
        })
        self.assertEqual(roi_job["content_region"], {
            "x": 766,
            "y": 511,
            "width": 4,
            "height": 2,
        })
        with Image.open(roi_job["reference_path"]) as reference:
            self.assertEqual(reference.format, "PNG")
            self.assertEqual(reference.mode, "RGBA")
            self.assertEqual(reference.size, (1536, 1024))
            self.assertEqual(reference.getpixel((0, 0)), (0, 0, 0, 0))
            self.assertEqual(reference.getpixel((766, 511)), (1, 2, 3, 0))

    def test_rejects_non_codex_rgba_route(self):
        preflight_path = self.job / "preflight.json"
        preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
        preflight["layers"][0]["execution_route_hint"] = "alpha_extract"
        preflight_path.write_text(json.dumps(preflight), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "only valid for codex_rgba, codex_rgba_repair, targeted_repair, or result_refinement"):
            MODULE.prepare_canvas(self.job_id, "title-one", jobs_root=self.root)

    def test_rejects_cross_platform_unsafe_layer_ids_before_writing_files(self):
        preflight_path = self.job / "preflight.json"
        for layer_id in ("../escape", r"..\escape", r"C:\escape", "/tmp/escape", r"\\server\share"):
            with self.subTest(layer_id=layer_id):
                preflight = json.loads(preflight_path.read_text(encoding="utf-8"))
                preflight["layers"][0]["id"] = layer_id
                preflight_path.write_text(json.dumps(preflight), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "unsafe layer id"):
                    MODULE.prepare_canvas(self.job_id, layer_id, jobs_root=self.root)
                self.assertFalse((self.job / "generated").exists())


if __name__ == "__main__":
    unittest.main()
