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
