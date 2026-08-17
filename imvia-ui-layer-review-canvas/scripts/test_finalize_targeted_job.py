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

    def test_result_refinement_reserves_each_version_path_exclusively(self):
        existing = self.job / "final" / "layer-one-v001.png"
        existing.write_bytes(b"existing-parent-version")
        first, first_marker = MODULE.reserve_versioned_output_path(
            self.job / "final", "layer-one"
        )
        second, second_marker = MODULE.reserve_versioned_output_path(
            self.job / "final", "layer-one"
        )

        self.assertEqual(first.name, "layer-one-v002.png")
        self.assertEqual(second.name, "layer-one-v003.png")
        self.assertEqual(existing.read_bytes(), b"existing-parent-version")
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        self.assertEqual(first_marker.name, ".layer-one-v002.reserve")
        self.assertEqual(second_marker.name, ".layer-one-v003.reserve")
        self.assertTrue(first_marker.is_file())
        self.assertTrue(second_marker.is_file())

    def configure_result_refinement_v2(self, *, with_repair=True, candidate_mode="RGB"):
        base = Image.new("RGBA", (6, 4), (10, 20, 30, 128))
        base.putpixel((0, 0), (70, 80, 90, 0))
        base.save(self.source)
        annotations = []
        jobs = []
        bindings = []
        repair_ids = []
        if with_repair:
            annotations.append({
                "id": "repair",
                "shape": "bezier_path",
                "closed": True,
                "kind": "boundary",
                "operation_role": "repair",
                "source_polygon_pixels": [
                    {"x": 2, "y": 1}, {"x": 5, "y": 1},
                    {"x": 5, "y": 3}, {"x": 2, "y": 3},
                ],
            })
            repair_ids.append("repair")
            reference_path = self.job / "generated" / "layer-one-repair-tile-001-reference.png"
            reference = Image.new("RGBA", (1536, 1024), (0, 0, 0, 0))
            reference.paste(base.crop((1, 0, 6, 4)), (765, 510))
            reference.save(reference_path)
            jobs.append({
                "roi_id": "repair-tile-001",
                "path_id": "repair",
                "base_region": {"x": 1, "y": 0, "width": 5, "height": 4},
                "canvas": {"width": 1536, "height": 1024},
                "content_region": {"x": 765, "y": 510, "width": 5, "height": 4},
                "reference_path": str(reference_path),
            })
            candidate_path = self.job / "generated" / "repair-candidate.png"
            color = (200, 100, 50) if candidate_mode == "RGB" else (200, 100, 50, 0)
            Image.new(candidate_mode, (1536, 1024), color).save(candidate_path)
            bindings.append(f"repair-tile-001={candidate_path}")

        operation = {
            "mode": "path_scoped",
            "subject_path_ids": [],
            "alpha_include_path_ids": [],
        }
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
            "repair_path_ids": repair_ids,
            "erase_path_ids": [],
            "protect_path_ids": [],
            "refinement_operation": operation,
            "expected_roi_tile_count": len(jobs),
            "maximum_imagegen_calls": len(jobs) * 2,
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        manifest_path = self.job / "generated" / "layer-one-imagegen-manifest.json"
        manifest_path.write_text(json.dumps({
            "version": 2,
            "generated_input_kind": "result_refinement_roi_manifest",
            "execution_route": "result_refinement",
            "base_png_dimensions": {"width": 6, "height": 4},
            "operation": operation,
            "roi_jobs": jobs,
        }), encoding="utf-8")
        return manifest_path, bindings

    def test_result_refinement_v2_writes_versioned_rgba_and_completed_report(self):
        manifest_path, bindings = self.configure_result_refinement_v2(candidate_mode="RGB")

        def forbidden_rmbg(*_args):
            self.fail("result_refinement must not call RMBG")

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            bindings,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=manifest_path,
            rmbg_runner=forbidden_rmbg,
        )

        output_path = Path(report["output_path"])
        self.assertRegex(output_path.name, r"^layer-one-v\d{3}\.png$")
        with Image.open(output_path) as output:
            self.assertEqual(output.format, "PNG")
            self.assertEqual(output.mode, "RGBA")
            self.assertEqual(output.size, (6, 4))
            self.assertEqual(output.getpixel((0, 0)), (70, 80, 90, 0))
            self.assertEqual(output.getpixel((3, 2)), (200, 100, 50, 128))
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["roi_count"], 1)
        self.assertEqual(report["candidate_count"], 1)
        self.assertEqual(report["imagegen_call_budget"], 2)
        self.assertEqual(report["asset_dimensions"], {"width": 6, "height": 4})
        self.assertEqual(report["validation_results"], {
            "dimensions": True,
            "alpha": True,
            "annotation_conformance": True,
            "outside_pixel_lock": True,
            "no_baked_checkerboard": True,
            "structure_integrity": True,
        })
        self.assertFalse(report["rmbg"]["required"])
        self.assertEqual(list((self.job / "final").glob(".*.reserve")), [])

    def test_result_refinement_failure_keeps_existing_final_version_unchanged(self):
        manifest_path, _bindings = self.configure_result_refinement_v2()
        existing = self.job / "final" / "layer-one-v001.png"
        existing.write_bytes(b"existing-version")

        with self.assertRaisesRegex(ValueError, "missing"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                [],
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(existing.read_bytes(), b"existing-version")
        self.assertEqual(list((self.job / "final").iterdir()), [existing])
        failed = json.loads((self.job / "execution-report.json").read_text(encoding="utf-8"))
        self.assertEqual(failed["status"], "failed")
        self.assertFalse(failed["validation_results"]["outside_pixel_lock"])

    def test_result_refinement_publish_failure_removes_hidden_reservation_and_output(self):
        manifest_path, bindings = self.configure_result_refinement_v2()

        def fail_publish(_source, _destination):
            raise OSError("injected publish failure")

        with self.assertRaisesRegex(OSError, "injected publish failure"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
                asset_publisher=fail_publish,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])
        report = json.loads((self.job / "execution-report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "failed")

    def test_result_refinement_report_failure_rolls_back_published_version(self):
        manifest_path, bindings = self.configure_result_refinement_v2()

        def fail_completed_report(_path, _report):
            raise OSError("injected report failure")

        with self.assertRaisesRegex(OSError, "injected report failure"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
                completed_report_writer=fail_completed_report,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])
        report = json.loads((self.job / "execution-report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "failed")

    def test_result_refinement_manifest_count_mismatch_does_not_reserve_version(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        self.plan["layers"][0]["expected_roi_tile_count"] = 2
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "ROI count"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])

    def test_result_refinement_reference_content_must_equal_the_base_crop(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        reference_path = Path(manifest["roi_jobs"][0]["reference_path"])
        with Image.open(reference_path) as image:
            tampered = image.copy()
        tampered.putpixel((767, 512), (1, 2, 3, 4))
        tampered.save(reference_path)

        with self.assertRaisesRegex(ValueError, "reference pixels"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])

    def test_result_refinement_reference_padding_must_be_transparent(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        reference_path = Path(manifest["roi_jobs"][0]["reference_path"])
        with Image.open(reference_path) as image:
            tampered = image.copy()
        tampered.putpixel((0, 0), (1, 2, 3, 255))
        tampered.save(reference_path)

        with self.assertRaisesRegex(ValueError, "reference pixels"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])

    def test_result_refinement_reference_must_be_an_actual_rgba_png(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        reference_path = Path(manifest["roi_jobs"][0]["reference_path"])
        with Image.open(reference_path) as image:
            image.convert("RGB").save(reference_path)

        with self.assertRaisesRegex(ValueError, "reference.*canvas"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

    def test_result_refinement_imagegen_budget_must_be_exactly_twice_roi_count(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        self.plan["layers"][0]["maximum_imagegen_calls"] = 3
        (self.job / "layer-review-plan.json").write_text(
            json.dumps(self.plan), encoding="utf-8"
        )

        with self.assertRaisesRegex(ValueError, "exactly twice"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])

    def test_result_refinement_rejects_noncanonical_native_roi_geometry(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["roi_jobs"][0]["base_region"] = {
            "x": 0, "y": 0, "width": 6, "height": 4,
        }
        manifest["roi_jobs"][0]["content_region"] = {
            "x": 765, "y": 510, "width": 6, "height": 4,
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "canonical native ROI jobs"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(list((self.job / "final").iterdir()), [])

    def test_result_refinement_zero_roi_task_needs_no_generated_input(self):
        manifest_path, bindings = self.configure_result_refinement_v2(with_repair=False)
        self.assertEqual(self.plan["layers"][0]["maximum_imagegen_calls"], 0)
        erase = {
            "id": "erase",
            "shape": "bezier_path",
            "closed": True,
            "kind": "erase",
            "operation_role": "erase",
            "source_polygon_pixels": [
                {"x": 2, "y": 1}, {"x": 5, "y": 1},
                {"x": 5, "y": 3}, {"x": 2, "y": 3},
            ],
        }
        self.plan["layers"][0]["mask_annotations"] = [erase]
        self.plan["layers"][0]["erase_path_ids"] = ["erase"]
        self.plan["layers"][0].pop("expected_roi_tile_count")
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        trusted_layer = {
            **self.plan["layers"][0],
            "expected_roi_tile_count": 0,
        }
        (self.job / "preflight.json").write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "source_path": str(self.source),
            "output_directory": str(self.job / "final"),
            "generated_directory": str(self.job / "generated"),
            "layers": [trusted_layer],
        }), encoding="utf-8")

        report = MODULE.finalize_job(
            self.job_id,
            "layer-one",
            bindings,
            jobs_root=self.root,
            rmbg_script=self.root / "missing-rmbg.py",
            imagegen_mapping=manifest_path,
        )

        with Image.open(report["output_path"]) as output:
            self.assertEqual(output.getpixel((3, 2)), (10, 20, 30, 0))
            self.assertEqual(output.getpixel((0, 0)), (70, 80, 90, 0))
        self.assertEqual(report["candidate_count"], 0)

    def test_result_structure_allows_fully_opaque_explicit_alpha_inclusion(self):
        base = Image.new("RGBA", (3, 2), (10, 20, 30, 0))
        result = Image.new("RGBA", base.size, (40, 50, 60, 255))
        annotations = [{
            "id": "include",
            "shape": "bezier_path",
            "closed": True,
            "kind": "boundary",
            "operation_role": "repair",
            "source_polygon_pixels": [
                {"x": 0, "y": 0}, {"x": 3, "y": 0},
                {"x": 3, "y": 2}, {"x": 0, "y": 2},
            ],
        }]
        operation = {
            "mode": "path_scoped",
            "subject_path_ids": [],
            "alpha_include_path_ids": ["include"],
        }

        MODULE.validate_result_refinement_structure(
            result,
            base,
            annotations=annotations,
            operation=operation,
        )

    def test_result_structure_allows_fully_transparent_explicit_erase(self):
        base = Image.new("RGBA", (3, 2), (10, 20, 30, 255))
        result = Image.new("RGBA", base.size, (10, 20, 30, 0))
        annotations = [{
            "id": "erase",
            "shape": "bezier_path",
            "closed": True,
            "kind": "erase",
            "operation_role": "erase",
            "source_polygon_pixels": [
                {"x": 0, "y": 0}, {"x": 3, "y": 0},
                {"x": 3, "y": 2}, {"x": 0, "y": 2},
            ],
        }]

        MODULE.validate_result_refinement_structure(
            result,
            base,
            annotations=annotations,
            operation={
                "mode": "path_scoped",
                "subject_path_ids": [],
                "alpha_include_path_ids": [],
            },
        )

    def test_result_structure_rejects_unauthorized_alpha_changes(self):
        base = Image.new("RGBA", (3, 2), (10, 20, 30, 128))
        result = Image.new("RGBA", base.size, (10, 20, 30, 255))

        with self.assertRaisesRegex(ValueError, "unauthorized Alpha"):
            MODULE.validate_result_refinement_structure(
                result,
                base,
                annotations=[],
                operation={
                    "mode": "path_scoped",
                    "subject_path_ids": [],
                    "alpha_include_path_ids": [],
                },
            )

    def test_result_structure_rejects_alpha_change_outside_local_inclusion(self):
        base = Image.new("RGBA", (4, 4), (10, 20, 30, 255))
        result = base.copy()
        result.putpixel((3, 2), (10, 20, 30, 0))
        local_include = {
            "id": "include",
            "shape": "bezier_path",
            "closed": True,
            "kind": "boundary",
            "operation_role": "repair",
            "source_polygon_pixels": [
                {"x": 0, "y": 0}, {"x": 1, "y": 0},
                {"x": 1, "y": 4}, {"x": 0, "y": 4},
            ],
        }

        with self.assertRaisesRegex(ValueError, "unauthorized Alpha"):
            MODULE.validate_result_refinement_structure(
                result,
                base,
                annotations=[local_include],
                operation={
                    "mode": "path_scoped",
                    "subject_path_ids": [],
                    "alpha_include_path_ids": ["include"],
                },
            )

    def test_result_refinement_rejects_duplicate_cli_bindings(self):
        candidate = (self.job / "generated" / "duplicate-binding.png").resolve()
        Image.new("RGBA", (2, 2), (20, 40, 60, 255)).save(candidate)
        binding = f"repair-tile-001={candidate}"

        with self.assertRaisesRegex(
            ValueError,
            "^duplicate result_refinement candidate binding: repair-tile-001$",
        ):
            MODULE.parse_result_refinement_bindings([binding, binding])

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
        failed = json.loads((self.job / "execution-report.json").read_text(encoding="utf-8"))
        self.assertEqual(failed["status"], "failed")
        self.assertTrue(all(value is False for value in failed["validation_results"].values()))

    def test_malformed_plan_writes_failed_report_without_replacing_existing_final(self):
        existing = self.job / "final" / "layer-one.png"
        existing.write_bytes(b"existing-success")
        (self.job / "layer-review-plan.json").write_text("{", encoding="utf-8")

        with self.assertRaises(json.JSONDecodeError):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
            )

        self.assertEqual(existing.read_bytes(), b"existing-success")
        failed = json.loads((self.job / "execution-report.json").read_text(encoding="utf-8"))
        self.assertEqual(failed["status"], "failed")
        self.assertTrue(all(value is False for value in failed["validation_results"].values()))

    def test_early_result_validation_uses_result_fields_and_keeps_existing_version(self):
        manifest_path, bindings = self.configure_result_refinement_v2()
        existing = self.job / "final" / "layer-one-v001.png"
        existing.write_bytes(b"existing-version")
        self.plan["layers"][0]["expected_output"]["width"] = 0
        (self.job / "layer-review-plan.json").write_text(
            json.dumps(self.plan), encoding="utf-8"
        )

        with self.assertRaisesRegex(ValueError, "expected output dimensions"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                bindings,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=manifest_path,
            )

        self.assertEqual(existing.read_bytes(), b"existing-version")
        failed = json.loads((self.job / "execution-report.json").read_text(encoding="utf-8"))
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(
            set(failed["validation_results"]),
            set(MODULE.RESULT_REFINEMENT_VALIDATION_KEYS),
        )
        self.assertTrue(all(value is False for value in failed["validation_results"].values()))

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

    def test_targeted_repair_rmbg_accepts_uniformly_scaled_native_canvas(self):
        self.plan["layers"][0].update({
            "execution_route_hint": "targeted_repair",
            "expected_output": {
                "width": 658,
                "height": 665,
                "original_source_x": 0,
                "original_source_y": 214,
            },
            "remove_background": True,
            "transparency_strategy": "rembg",
            "rmbg_required": True,
            "output_resolution_policy": "native_imagegen_content",
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        Image.new("RGBA", (1254, 1254), (210, 40, 20, 255)).save(self.generated)
        mapping_path = self.job / "generated" / "repair-mapping.json"
        mapping_path.write_text(json.dumps({
            "version": 1,
            "job_id": self.job_id,
            "layer_id": "layer-one",
            "generated_input_kind": "targeted_repair_canvas",
            "execution_route": "targeted_repair",
            "canvas": {"width": 1024, "height": 1024},
            "content_region": {"x": 5, "y": 0, "width": 1013, "height": 1024},
            "expected_output": {"width": 658, "height": 665},
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

        self.assertEqual(received, [((1241, 1254), 1241, 1254)])
        self.assertEqual(report["asset_dimensions"], {"width": 1241, "height": 1254})
        with Image.open(self.job / "final" / "layer-one.png") as image:
            self.assertEqual(image.size, (1241, 1254))

    def test_targeted_repair_rejects_a_native_canvas_with_changed_aspect_ratio(self):
        self.plan["layers"][0].update({
            "execution_route_hint": "targeted_repair",
            "remove_background": True,
            "transparency_strategy": "rembg",
            "rmbg_required": True,
            "output_resolution_policy": "native_imagegen_content",
        })
        (self.job / "layer-review-plan.json").write_text(json.dumps(self.plan), encoding="utf-8")
        Image.new("RGBA", (1254, 1200), (210, 40, 20, 255)).save(self.generated)
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

        with self.assertRaisesRegex(ValueError, "aspect ratio"):
            MODULE.finalize_job(
                self.job_id,
                "layer-one",
                self.generated,
                jobs_root=self.root,
                rmbg_script=self.root / "missing-rmbg.py",
                imagegen_mapping=mapping_path,
            )

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
