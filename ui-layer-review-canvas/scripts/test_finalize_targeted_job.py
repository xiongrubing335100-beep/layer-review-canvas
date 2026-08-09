import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).with_name("finalize-targeted-job.py")
SPEC = importlib.util.spec_from_file_location("finalize_targeted_job", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FinalizeTargetedJobTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="finalize-targeted-test-"))
        self.job_id = "layer-job-test"
        self.job = self.root / self.job_id
        (self.job / "generated").mkdir(parents=True)
        (self.job / "final").mkdir()
        self.source = self.job / "source.png"
        Image.new("RGBA", (4, 4), (10, 20, 30, 255)).save(self.source)
        self.generated = self.job / "generated" / "candidate.png"
        Image.new("RGBA", (2, 2), (200, 100, 50, 255)).save(self.generated)
        self.plan = {
            "output_directory": str(self.job / "final"),
            "source": {"local_path": str(self.source)},
            "execution_timing": {"submitted_at": "2026-08-03T00:00:00Z"},
            "layers": [{
                "id": "layer-one",
                "name": "组件",
                "execution_route_hint": "direct_crop",
                "expected_output": {"width": 2, "height": 2, "original_source_x": 1, "original_source_y": 1},
                "remove_background": False,
            }],
        }
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

    def tearDown(self):
        for child in sorted(self.root.rglob("*"), reverse=True):
            if child.is_file() or child.is_symlink():
                child.unlink()
            elif child.exists():
                child.rmdir()
        self.root.rmdir()

    def configure_result_refinement(self, annotations, *, candidate_mode="RGBA"):
        base = Image.new("RGBA", (4, 4), (10, 20, 30, 255))
        base.putpixel((1, 1), (40, 50, 60, 128))
        base.putpixel((3, 3), (70, 80, 90, 0))
        base.save(self.source)
        self.plan.update({
            "parent_job_id": "parent-job",
            "parent_version_id": "parent-version-3",
        })
        self.plan["layers"][0].update({
            "execution_route_hint": "result_refinement",
            "transparency_strategy": "preserve_existing_alpha",
            "rmbg_required": False,
            "output_resolution_policy": "existing_result_pixels",
            "placement": {"x": 11, "y": 12, "width": 99, "height": 88},
            "mask_annotations": annotations,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        canvas = Image.new(candidate_mode, (1024, 1024), (200, 100, 50, 255)[:len(candidate_mode)])
        canvas.save(self.generated)
        mapping_path = self.job / "generated" / "result-refinement-mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "result_refinement_canvas",
            "execution_route": "result_refinement",
            "canvas": {"width": 1024, "height": 1024},
            "content_region": {"x": 0, "y": 0, "width": 1024, "height": 1024},
            "expected_output": {"width": 4, "height": 4},
            "base_png_dimensions": {"width": 4, "height": 4},
        }), encoding="utf-8")
        return mapping_path

    def test_result_refinement_reserves_each_version_path_exclusively(self):
        existing = self.job / "final" / "layer-one-v001.png"
        existing.write_bytes(b"existing-parent-version")
        first = MODULE.reserve_versioned_output_path(self.job / "final", "layer-one")
        second = MODULE.reserve_versioned_output_path(self.job / "final", "layer-one")

        self.assertEqual(first.name, "layer-one-v002.png")
        self.assertEqual(second.name, "layer-one-v003.png")
        self.assertEqual(existing.read_bytes(), b"existing-parent-version")
        self.assertTrue(first.is_file())
        self.assertTrue(second.is_file())

    def test_versioned_outputs_reject_cross_platform_unsafe_layer_ids(self):
        for layer_id in ("../escape", r"..\escape", r"C:\escape", "/tmp/escape", r"\\server\share"):
            with self.subTest(layer_id=layer_id):
                with self.assertRaisesRegex(ValueError, "unsafe layer id"):
                    MODULE.reserve_versioned_output_path(self.job / "final", layer_id)

        self.assertEqual(list((self.job / "final").iterdir()), [])

    def test_rejects_a_final_directory_symlink_that_escapes_the_job(self):
        final_directory = self.job / "final"
        final_directory.rmdir()
        escaped_directory = self.root / "escaped-final"
        escaped_directory.mkdir()
        final_directory.symlink_to(escaped_directory, target_is_directory=True)

        with self.assertRaisesRegex(ValueError, "escapes"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
            )

        self.assertEqual(list(escaped_directory.iterdir()), [])

    def test_writes_exact_size_png_and_completed_report(self):
        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            clock=iter([
                "2026-08-03T00:00:01Z",
                "2026-08-03T00:00:02Z",
                "2026-08-03T00:00:03Z",
            ]).__next__,
        )
        self.assertEqual(report["status"], "completed")
        output = self.job / "final" / "layer-one.png"
        self.assertTrue(output.is_file())
        with Image.open(output) as image:
            self.assertEqual(image.size, (2, 2))
        saved_report = json.loads((self.job / "execution-report.json").read_text())
        self.assertEqual(saved_report["status"], "completed")
        self.assertIn("validation_started_at", saved_report["timing"])

    def test_rejects_wrong_size_and_writes_failed_report(self):
        Image.new("RGBA", (3, 2), (1, 2, 3, 255)).save(self.generated)
        with self.assertRaisesRegex(ValueError, "already be 2x2"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
            )
        self.assertEqual(json.loads((self.job / "execution-report.json").read_text())["status"], "failed")

    def test_codex_rgba_accepts_native_imagegen_matte_canvas_and_preserves_source_rgb(self):
        self.plan["layers"][0].update({
            "category": "kvTitle",
            "execution_route_hint": "codex_rgba",
            "remove_background": True,
            "transparency_strategy": "codex_rgba",
            "rmbg_required": False,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        matte = Image.new("RGB", (4, 4), (0, 0, 0))
        matte.putpixel((1, 1), (255, 255, 255))
        matte.save(self.generated)
        mapping_path = self.job / "generated" / "mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "codex_alpha_matte",
            "canvas": {"width": 4, "height": 4},
            "content_region": {"x": 1, "y": 1, "width": 2, "height": 2},
            "expected_output": {"width": 2, "height": 2},
        }), encoding="utf-8")

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
        )

        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["transparency"]["generated_input_kind"], "codex_alpha_matte")
        with Image.open(self.job / "final" / "layer-one.png") as image:
            rgba = image.convert("RGBA")
            self.assertEqual(rgba.getpixel((0, 0))[:3], (10, 20, 30))
            self.assertEqual(rgba.getchannel("A").getextrema(), (0, 255))

    def test_codex_rgba_matte_rejects_changed_native_canvas(self):
        self.plan["layers"][0].update({
            "category": "ordinaryText",
            "execution_route_hint": "codex_rgba",
            "remove_background": True,
            "transparency_strategy": "codex_rgba",
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        mapping_path = self.job / "generated" / "mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "codex_alpha_matte",
            "canvas": {"width": 6, "height": 4},
            "content_region": {"x": 1, "y": 1, "width": 4, "height": 2},
            "expected_output": {"width": 2, "height": 2},
        }), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "preserve the prepared 6x4 canvas"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=mapping_path,
            )

    def test_targeted_repair_accepts_fixed_imagegen_canvas_mapping(self):
        self.plan["layers"][0]["execution_route_hint"] = "targeted_repair"
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        canvas = Image.new("RGBA", (1024, 1024), (210, 40, 20, 255))
        canvas.save(self.generated)
        mapping_path = self.job / "generated" / "repair-mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "targeted_repair_canvas",
            "execution_route": "targeted_repair",
            "canvas": {"width": 1024, "height": 1024},
            "content_region": {"x": 0, "y": 0, "width": 1024, "height": 1024},
            "expected_output": {"width": 2, "height": 2},
        }), encoding="utf-8")

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
        )

        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["transparency"]["generated_input_kind"], "targeted_repair_canvas")
        with Image.open(self.job / "final" / "layer-one.png") as image:
            rgba = image.convert("RGBA")
            self.assertEqual(rgba.size, (2, 2))
            self.assertEqual(rgba.getpixel((0, 0)), (210, 40, 20, 255))
            self.assertEqual(rgba.getpixel((1, 1)), (210, 40, 20, 255))

    def test_targeted_repair_rmbg_preserves_native_content_resolution(self):
        self.plan["layers"][0].update({
            "execution_route_hint": "targeted_repair",
            "remove_background": True,
            "transparency_strategy": "rembg",
            "rmbg_required": True,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        canvas = Image.new("RGBA", (1024, 1024), (210, 40, 20, 255))
        canvas.save(self.generated)
        mapping_path = self.job / "generated" / "repair-mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "targeted_repair_canvas",
            "execution_route": "targeted_repair",
            "canvas": {"width": 1024, "height": 1024},
            "content_region": {"x": 0, "y": 0, "width": 1024, "height": 1024},
            "expected_output": {"width": 2, "height": 2},
        }), encoding="utf-8")
        received = []

        def fake_rmbg(input_path, output_path, width, height, _script):
            with Image.open(input_path) as image:
                received.append((image.size, width, height))
                result = image.convert("RGBA")
            result.putpixel((0, 0), (210, 40, 20, 0))
            result.save(output_path)

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
            rmbg_runner=fake_rmbg,
        )

        self.assertEqual(received, [((1024, 1024), 1024, 1024)])
        self.assertEqual(report["output_resolution_policy"], "native_imagegen_content")
        self.assertEqual(report["asset_dimensions"], {"width": 1024, "height": 1024})
        self.assertEqual(report["logical_placement"], {
            "x": 1,
            "y": 1,
            "width": 2,
            "height": 2,
        })
        with Image.open(self.job / "final" / "layer-one.png") as image:
            self.assertEqual(image.size, (1024, 1024))

    def test_native_targeted_repair_scales_declared_source_lock_regions(self):
        self.plan["layers"][0].update({
            "execution_route_hint": "targeted_repair",
            "remove_background": True,
            "transparency_strategy": "rembg",
            "rmbg_required": True,
            "repair_regions": [{"x": 0, "y": 0, "width": 1, "height": 1}],
            "repair_region_source": "codex_declared",
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        Image.new("RGBA", (1024, 1024), (210, 40, 20, 255)).save(self.generated)
        mapping_path = self.job / "generated" / "repair-mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "targeted_repair_canvas",
            "execution_route": "targeted_repair",
            "canvas": {"width": 1024, "height": 1024},
            "content_region": {"x": 0, "y": 0, "width": 1024, "height": 1024},
            "expected_output": {"width": 2, "height": 2},
        }), encoding="utf-8")
        received_pixels = []

        def fake_rmbg(input_path, output_path, _width, _height, _script):
            with Image.open(input_path) as image:
                result = image.convert("RGBA")
            received_pixels.extend([
                result.getpixel((100, 100)),
                result.getpixel((900, 900)),
            ])
            result.putpixel((0, 0), (*result.getpixel((0, 0))[:3], 0))
            result.save(output_path)

        MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
            rmbg_runner=fake_rmbg,
        )

        self.assertEqual(received_pixels, [
            (210, 40, 20, 255),
            (10, 20, 30, 255),
        ])

    def test_targeted_repair_rejects_missing_imagegen_mapping(self):
        self.plan["layers"][0]["execution_route_hint"] = "targeted_repair"
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "requires --imagegen-mapping"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
            )

    def test_targeted_repair_mapping_rejects_changed_native_canvas(self):
        self.plan["layers"][0]["execution_route_hint"] = "targeted_repair"
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        mapping_path = self.job / "generated" / "repair-mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "targeted_repair_canvas",
            "execution_route": "targeted_repair",
            "canvas": {"width": 6, "height": 4},
            "content_region": {"x": 1, "y": 1, "width": 4, "height": 2},
            "expected_output": {"width": 2, "height": 2},
        }), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "canonical canvas geometry"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=mapping_path,
            )

    def test_result_refinement_locks_unmarked_rgba_and_uses_base_pixel_dimensions(self):
        mapping_path = self.configure_result_refinement([{
            "shape": "bezier_path",
            "closed": True,
            "kind": "boundary",
            "semantics": "edge_override",
            "order_index": 0,
            "source_polygon_pixels": [
                {"x": 1, "y": 1},
                {"x": 2, "y": 1},
                {"x": 2, "y": 2},
                {"x": 1, "y": 2},
            ],
        }])

        def forbidden_rmbg(*_args):
            self.fail("result_refinement must not call RMBG")

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
            rmbg_runner=forbidden_rmbg,
        )

        output_path = Path(report["output_path"])
        self.assertNotEqual(output_path, self.source)
        self.assertRegex(output_path.name, r"^layer-one-v\d{3}\.png$")
        with Image.open(output_path) as output:
            self.assertEqual(output.format, "PNG")
            self.assertEqual(output.mode, "RGBA")
            self.assertEqual(output.size, (4, 4))
            self.assertEqual(output.getpixel((0, 0)), (10, 20, 30, 255))
            self.assertEqual(output.getpixel((1, 1)), (200, 100, 50, 255))
            self.assertEqual(output.getpixel((3, 3)), (70, 80, 90, 0))
        with Image.open(self.source) as base:
            self.assertEqual(base.getpixel((1, 1)), (40, 50, 60, 128))
        self.assertEqual(report["parent_job_id"], "parent-job")
        self.assertEqual(report["parent_version_id"], "parent-version-3")
        self.assertEqual(report["input_dimensions"], {"width": 4, "height": 4})
        self.assertEqual(report["output_dimensions"], {"width": 4, "height": 4})
        self.assertEqual(report["annotation_count"], 1)
        self.assertTrue(report["preserve_existing_alpha"])
        self.assertFalse(report["rmbg"]["required"])
        self.assertEqual(report["logical_placement"], {
            "x": 11,
            "y": 12,
            "width": 99,
            "height": 88,
        })

    def test_result_refinement_explicit_erase_changes_only_annotated_alpha(self):
        mapping_path = self.configure_result_refinement([{
            "shape": "bezier_path",
            "closed": True,
            "kind": "background",
            "semantics": "force_exclude",
            "order_index": 0,
            "source_polygon_pixels": [
                {"x": 0, "y": 0},
                {"x": 1, "y": 0},
                {"x": 1, "y": 1},
                {"x": 0, "y": 1},
            ],
        }])

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
        )

        with Image.open(report["output_path"]) as output:
            self.assertEqual(output.getpixel((0, 0)), (200, 100, 50, 0))
            self.assertEqual(output.getpixel((2, 2)), (10, 20, 30, 255))
            self.assertEqual(output.getpixel((3, 3)), (70, 80, 90, 0))

    def test_result_refinement_force_keep_uses_candidate_rgba_over_transparent_base(self):
        base = Image.new("RGBA", (3, 3), (10, 20, 30, 255))
        base.putpixel((1, 1), (40, 50, 60, 0))
        candidate = Image.new("RGBA", (3, 3), (200, 100, 50, 192))

        output = MODULE.apply_result_refinement_pixel_lock(candidate, base, [{
            "shape": "bezier_path",
            "closed": True,
            "kind": "foreground",
            "semantics": "force_keep",
            "order_index": 0,
            "source_polygon_pixels": [
                {"x": 1, "y": 1},
                {"x": 2, "y": 1},
                {"x": 2, "y": 2},
                {"x": 1, "y": 2},
            ],
        }])

        self.assertEqual(output.getpixel((1, 1)), (200, 100, 50, 192))
        self.assertEqual(output.getpixel((0, 0)), (10, 20, 30, 255))

    def test_result_refinement_force_keep_after_erase_restores_candidate_rgba(self):
        polygon = [
            {"x": 1, "y": 1},
            {"x": 2, "y": 1},
            {"x": 2, "y": 2},
            {"x": 1, "y": 2},
        ]
        base = Image.new("RGBA", (3, 3), (10, 20, 30, 255))
        base.putpixel((1, 1), (40, 50, 60, 64))
        candidate = Image.new("RGBA", (3, 3), (200, 100, 50, 192))

        output = MODULE.apply_result_refinement_pixel_lock(candidate, base, [{
            "shape": "bezier_path",
            "closed": True,
            "kind": "foreground",
            "semantics": "force_keep",
            "order_index": 1,
            "source_polygon_pixels": polygon,
        }, {
            "shape": "bezier_path",
            "closed": True,
            "kind": "background",
            "semantics": "force_exclude",
            "order_index": 0,
            "source_polygon_pixels": polygon,
        }])

        self.assertEqual(output.getpixel((1, 1)), (200, 100, 50, 192))
        self.assertEqual(output.getpixel((0, 0)), (10, 20, 30, 255))

    def test_result_refinement_boundary_after_erase_does_not_cancel_erase(self):
        polygon = [
            {"x": 0, "y": 0},
            {"x": 1, "y": 0},
            {"x": 1, "y": 1},
            {"x": 0, "y": 1},
        ]
        mapping_path = self.configure_result_refinement([{
            "shape": "bezier_path",
            "closed": True,
            "kind": "boundary",
            "semantics": "edge_override",
            "order_index": 1,
            "source_polygon_pixels": polygon,
        }, {
            "shape": "bezier_path",
            "closed": True,
            "kind": "background",
            "semantics": "force_exclude",
            "order_index": 0,
            "source_polygon_pixels": polygon,
        }])

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
        )

        with Image.open(report["output_path"]) as output:
            self.assertEqual(output.getpixel((0, 0)), (200, 100, 50, 0))

    def test_result_refinement_text_only_can_edit_full_rgba_canvas(self):
        mapping_path = self.configure_result_refinement([])
        canvas = Image.new("RGBA", (1024, 1024), (200, 100, 50, 255))
        canvas.paste((200, 100, 50, 64), (0, 0, 512, 1024))
        canvas.save(self.generated)

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=mapping_path,
        )

        with Image.open(report["output_path"]) as output:
            self.assertEqual(output.mode, "RGBA")
            self.assertEqual(output.size, (4, 4))
            self.assertLess(output.getpixel((0, 0))[3], 128)
            self.assertLessEqual(
                max(abs(actual - expected) for actual, expected in zip(
                    output.getpixel((0, 0))[:3],
                    (200, 100, 50),
                )),
                3,
            )
            self.assertEqual(output.getpixel((3, 0))[3], 255)
            self.assertLessEqual(
                max(abs(actual - expected) for actual, expected in zip(
                    output.getpixel((3, 0))[:3],
                    (200, 100, 50),
                )),
                3,
            )
            self.assertEqual(output.getpixel((3, 3))[3], 255)

    def test_result_refinement_text_only_rejects_lost_base_transparency_structure(self):
        mapping_path = self.configure_result_refinement([])

        with self.assertRaisesRegex(ValueError, "retain transparent pixels"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=mapping_path,
            )

    def test_result_refinement_rejects_non_rgba_generated_png(self):
        mapping_path = self.configure_result_refinement([], candidate_mode="RGB")

        with self.assertRaisesRegex(ValueError, "must be an RGBA PNG"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=mapping_path,
            )

    def test_source_lock_only_runs_for_declared_repair_regions(self):
        self.plan["layers"][0]["repair_regions"] = [{"x": 0, "y": 0, "width": 1, "height": 1}]
        self.plan["layers"][0]["repair_region_source"] = "codex_declared"
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
        )
        image = Image.open(self.job / "final" / "layer-one.png").convert("RGBA")
        self.assertEqual(image.getpixel((1, 1)), (10, 20, 30, 255))
        self.assertEqual(image.getpixel((0, 0)), (200, 100, 50, 255))

    def test_records_rmbg_and_validation_timing(self):
        self.plan["layers"][0]["remove_background"] = True
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

        def fake_rmbg(_input, output, _width, _height, _script):
            image = Image.new("RGBA", (2, 2), (200, 100, 50, 255))
            image.putpixel((0, 0), (200, 100, 50, 0))
            image.save(output)

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            clock=iter([
                "2026-08-03T00:00:01Z",
                "2026-08-03T00:00:02Z",
                "2026-08-03T00:00:03Z",
                "2026-08-03T00:00:04Z",
                "2026-08-03T00:00:05Z",
            ]).__next__,
            rmbg_runner=fake_rmbg,
        )
        self.assertEqual(report["timing"]["rmbg_started_at"], "2026-08-03T00:00:02Z")
        self.assertEqual(report["timing"]["rmbg_completed_at"], "2026-08-03T00:00:03Z")
        self.assertEqual(report["timing"]["validation_started_at"], "2026-08-03T00:00:04Z")

    def test_codex_rgba_rejects_an_opaque_title_without_running_rmbg(self):
        self.plan["layers"][0].update({
            "category": "kvTitle",
            "execution_route_hint": "codex_rgba",
            "remove_background": True,
            "transparency_strategy": "codex_rgba",
            "rmbg_required": False,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

        def forbidden_rmbg(*_args):
            self.fail("Codex RGBA must not call RMBG")

        with self.assertRaisesRegex(ValueError, "real transparent"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                rmbg_runner=forbidden_rmbg,
            )
        self.assertFalse((self.job / "final" / "layer-one.png").exists())

    def test_codex_rgba_accepts_source_faithful_transparent_title(self):
        self.plan["layers"][0].update({
            "category": "kvTitle",
            "execution_route_hint": "codex_rgba",
            "remove_background": True,
            "transparency_strategy": "codex_rgba",
            "rmbg_required": False,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        candidate = Image.new("RGBA", (2, 2), (10, 20, 30, 255))
        candidate.putpixel((0, 0), (10, 20, 30, 0))
        candidate.save(self.generated)

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            self.generated,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
        )

        self.assertEqual(report["status"], "completed")
        self.assertFalse(report["rmbg"]["required"])
        self.assertEqual(report["transparency"]["strategy"], "codex_rgba")
        self.assertTrue(report["validation_results"]["structure_integrity"])

    def test_codex_rgba_rejects_changed_visible_glyph_rgb(self):
        self.plan["layers"][0].update({
            "category": "ordinaryText",
            "execution_route_hint": "codex_rgba",
            "remove_background": True,
            "transparency_strategy": "codex_rgba",
            "rmbg_required": False,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        candidate = Image.new("RGBA", (2, 2), (200, 100, 50, 255))
        candidate.putpixel((0, 0), (200, 100, 50, 0))
        candidate.save(self.generated)

        with self.assertRaisesRegex(ValueError, "changed reliable source glyph"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
            )


if __name__ == "__main__":
    unittest.main()
