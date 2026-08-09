import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).with_name("result_refinement_roi.py")
MODULE = None
if MODULE_PATH.is_file():
    SPEC = importlib.util.spec_from_file_location("result_refinement_roi", MODULE_PATH)
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


def annotation(path_id, points, operation_role="repair"):
    return {
        "id": path_id,
        "kind": "boundary",
        "operation_role": operation_role,
        "source_polygon_pixels": [
            {"x": x, "y": y} for x, y in points
        ],
    }


class ResultRefinementRoiGeometryTests(unittest.TestCase):
    def require_module(self):
        self.assertIsNotNone(MODULE, "result_refinement_roi module is missing")
        return MODULE

    def test_small_roi_is_centered_at_native_size_without_resampling(self):
        region = self.require_module().place_native_region((132, 146), (1024, 1024))
        self.assertEqual(region, {"x": 446, "y": 439, "width": 132, "height": 146})

    def test_large_roi_splits_into_native_tiles_with_32_pixel_overlap(self):
        tiles = self.require_module().tile_region(
            {"x": 0, "y": 0, "width": 1800, "height": 900},
            (1536, 1024),
            32,
        )
        self.assertEqual(tiles[0], {"x": 0, "y": 0, "width": 1536, "height": 900})
        self.assertEqual(tiles[1], {"x": 1504, "y": 0, "width": 296, "height": 900})
        self.assertLessEqual(max(tile["width"] for tile in tiles), 1536)

    def test_padding_ratio_is_clamped_to_three_and_fifteen_percent(self):
        module = self.require_module()
        bounds = {"x": 200, "y": 200, "width": 100, "height": 50}
        self.assertEqual(
            module.padded_region(bounds, (1000, 1000), ratio=0.01),
            {"x": 197, "y": 197, "width": 106, "height": 56},
        )
        self.assertEqual(
            module.padded_region(bounds, (1000, 1000), ratio=0.25),
            {"x": 185, "y": 185, "width": 130, "height": 80},
        )

    def test_polygon_bounds_and_padding_clip_to_base_boundaries(self):
        module = self.require_module()
        bounds = module.polygon_bounds(
            [(-2.5, -8), (20.2, 0), (20.2, 10.1), (0, 10.1)],
            (100, 80),
        )
        self.assertEqual(bounds, {"x": 0, "y": 0, "width": 21, "height": 11})
        self.assertEqual(
            module.padded_region(bounds, (100, 80)),
            {"x": 0, "y": 0, "width": 23, "height": 13},
        )


class ResultRefinementManifestTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="result-refinement-roi-test-"))
        self.generated = self.root / "generated"
        self.base_path = self.root / "base.png"
        base = Image.new("RGBA", (200, 160), (10, 20, 30, 255))
        for y in range(base.height):
            for x in range(base.width):
                base.putpixel((x, y), (x % 256, y % 256, (x + y) % 256, (x * 3 + y) % 256))
        base.save(self.base_path)

    def tearDown(self):
        for child in sorted(self.root.rglob("*"), reverse=True):
            if child.is_file() or child.is_symlink():
                child.unlink()
            elif child.exists():
                child.rmdir()
        self.root.rmdir()

    def require_module(self):
        self.assertIsNotNone(MODULE, "result_refinement_roi module is missing")
        return MODULE

    def layer(self, annotations, repair_ids, expected_count, *, operation=None):
        operation = operation or {
            "mode": "path_scoped",
            "subject_path_ids": [],
            "alpha_include_path_ids": [],
        }
        return {
            "refinement_operation": operation,
            "roi_policy": dict(ROI_POLICY),
            "mask_annotations": annotations,
            "repair_path_ids": repair_ids,
            "expected_roi_tile_count": expected_count,
        }

    def build(self, layer, layer_id="layer-one"):
        return self.require_module().build_result_refinement_manifest(
            "layer-job-test",
            layer_id,
            layer,
            self.base_path,
            self.generated,
        )

    def test_two_distant_repair_paths_produce_separate_native_jobs(self):
        paths = [
            annotation("coin-left", [(20, 70), (120, 70), (120, 130), (20, 130)]),
            annotation("coin-right", [(140, 20), (190, 20), (190, 60), (140, 60)]),
        ]
        manifest_path, manifest = self.build(self.layer(paths, ["coin-left", "coin-right"], 2))

        self.assertTrue(manifest_path.is_file())
        self.assertEqual(manifest["version"], 2)
        self.assertEqual(manifest["generated_input_kind"], "result_refinement_roi_manifest")
        self.assertEqual(manifest["execution_route"], "result_refinement")
        self.assertEqual(manifest["base_png_dimensions"], {"width": 200, "height": 160})
        self.assertEqual(manifest["operation"], {
            "mode": "path_scoped",
            "subject_path_ids": [],
            "alpha_include_path_ids": [],
        })
        self.assertEqual([job["path_id"] for job in manifest["roi_jobs"]], ["coin-left", "coin-right"])
        self.assertEqual([job["roi_id"] for job in manifest["roi_jobs"]], [
            "coin-left-tile-001", "coin-right-tile-001",
        ])
        self.assertEqual(json.loads(manifest_path.read_text(encoding="utf-8")), manifest)

    def test_subject_path_produces_no_repair_job(self):
        paths = [
            annotation("subject", [(0, 0), (40, 0), (40, 40), (0, 40)], "subject"),
            annotation("repair", [(80, 80), (120, 80), (120, 120), (80, 120)]),
        ]
        operation = {
            "mode": "keep_inside_delete_outside",
            "subject_path_ids": ["subject"],
            "alpha_include_path_ids": ["repair"],
        }
        _, manifest = self.build(self.layer(paths, ["repair"], 1, operation=operation))

        self.assertEqual([job["path_id"] for job in manifest["roi_jobs"]], ["repair"])
        self.assertEqual(manifest["operation"], operation)

    def test_erase_only_task_produces_empty_roi_jobs(self):
        erase = {
            "id": "erase-one",
            "kind": "erase",
            "operation_role": "erase",
            "source_polygon_pixels": [
                {"x": 10, "y": 10}, {"x": 20, "y": 10},
                {"x": 20, "y": 20}, {"x": 10, "y": 20},
            ],
        }
        manifest_path, manifest = self.build(self.layer([erase], [], 0))

        self.assertTrue(manifest_path.is_file())
        self.assertEqual(manifest["roi_jobs"], [])
        self.assertEqual(list(self.generated.glob("*-reference.png")), [])

    def test_unsafe_path_ids_are_rejected_before_writing(self):
        for path_id in ("../escape", r"..\escape", r"C:\escape", "/tmp/escape", r"\\server\share"):
            with self.subTest(path_id=path_id):
                path = annotation(path_id, [(10, 10), (30, 10), (30, 30), (10, 30)])
                with self.assertRaisesRegex(ValueError, "unsafe layer id"):
                    self.build(self.layer([path], [path_id], 1))
                self.assertFalse(self.generated.exists())

    def test_reference_content_pixels_equal_the_native_base_roi(self):
        repair = annotation("coin", [(20, 70), (120, 70), (120, 130), (20, 130)])
        _, manifest = self.build(self.layer([repair], ["coin"], 1))
        job = manifest["roi_jobs"][0]

        self.assertEqual(job["base_region"], {"x": 12, "y": 62, "width": 116, "height": 76})
        self.assertEqual(job["canvas"], {"width": 1536, "height": 1024})
        self.assertEqual(job["content_region"], {"x": 710, "y": 474, "width": 116, "height": 76})
        with Image.open(self.base_path) as base, Image.open(job["reference_path"]) as reference:
            expected = base.crop((12, 62, 128, 138))
            actual = reference.crop((710, 474, 826, 550))
            self.assertEqual(actual.mode, "RGBA")
            self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_explicit_full_base_maps_at_native_size_with_vertical_padding(self):
        base = Image.new("RGBA", (1024, 1243), (5, 15, 25, 128))
        base.save(self.base_path)
        operation = {
            "mode": "full_canvas_explicit",
            "subject_path_ids": [],
            "alpha_include_path_ids": [],
        }
        _, manifest = self.build(self.layer([], [], 1, operation=operation))

        self.assertEqual(manifest["roi_jobs"][0]["base_region"], {
            "x": 0, "y": 0, "width": 1024, "height": 1243,
        })
        self.assertEqual(manifest["roi_jobs"][0]["canvas"], {"width": 1024, "height": 1536})
        self.assertEqual(manifest["roi_jobs"][0]["content_region"], {
            "x": 0, "y": 146, "width": 1024, "height": 1243,
        })

    def test_manifest_rejects_a_tile_count_that_disagrees_with_trusted_preflight(self):
        repair = annotation("coin", [(20, 70), (120, 70), (120, 130), (20, 130)])
        with self.assertRaisesRegex(ValueError, "expected_roi_tile_count"):
            self.build(self.layer([repair], ["coin"], 2))
        self.assertFalse(self.generated.exists())


if __name__ == "__main__":
    unittest.main()
