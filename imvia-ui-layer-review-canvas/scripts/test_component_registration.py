import importlib.util
from pathlib import Path
import unittest
import tempfile
import hashlib
import json
import cv2
import numpy as np
from PIL import Image

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

fit = module("component_fit", "component-rgba-registration.py")
sampling = module("component_sample", "component-rgba-sampling.py")

class RegistrationTests(unittest.TestCase):
    def test_thin_stroke_translation_is_not_limited_by_stroke_thickness(self):
        source = np.full((100, 160, 3), 20, np.uint8)
        expected = np.zeros((100, 160), np.uint8)
        expected[20:60, 20:24] = 255
        expected[60:80, 100:120] = 255
        source[expected > 0] = 235
        raw = np.zeros((100, 160, 4), np.uint8)
        raw[20:60, 23:27] = 235
        raw[20:60, 23:27, 3] = 255
        raw[60:80, 100:120] = 235
        raw[60:80, 100:120, 3] = 255
        transforms, anchor, _ = fit.fit_components(
            Image.fromarray(source), Image.fromarray(raw),
            required_region=np.ones(expected.shape, bool),
            fixed_anchor=np.array([[1., 0., 0.], [0., 1., 0.]]))
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 160, "height": 100}}
        actual = np.asarray(sampling.sample_components(
            Image.fromarray(raw), transforms, mapping, (160, 100),
            residual_transform=anchor))[..., 3] >= 128
        # Check the thin stroke separately; the larger square must not hide it.
        truth = expected[:60, :50] > 0
        found = actual[:60, :50]
        self.assertGreater(np.count_nonzero(truth & found)/np.count_nonzero(truth | found), .9)

    def test_bounded_search_escapes_coordinatewise_local_minimum(self):
        # A joint coordinate move is needed; either one-axis move alone worsens
        # the broad false match. Local-only Powell stays at loss 1.
        def loss(p):
            self.assertTrue(np.all(np.abs(p) <= 1.000001))
            return min(1 + float(np.sum(p*p)),
                       40 * float(np.sum((p-.65)**2)))
        proposal = fit.fit_bounded_proposal(
            loss, [np.zeros(2), np.full(2, -.1)], [(-1., 1.)]*2,
            lambda p: loss(p) < .1)
        self.assertLess(loss(proposal.x), .01)
        np.testing.assert_allclose(proposal.x, [.65, .65], atol=.01)

    def test_bounded_search_does_not_manufacture_missing_evidence(self):
        proposal = fit.fit_bounded_proposal(
            lambda p: 2 + float(np.sum(p*p)), [np.zeros(2)], [(-1., 1.)]*2,
            lambda p: False)
        self.assertGreaterEqual(proposal.fun, 2)
        self.assertTrue(np.all(np.abs(proposal.x) <= 1))

    def test_nearby_component_with_no_anchored_patch_coverage_is_not_fitted(self):
        alpha = np.zeros((180, 300), np.uint8)
        alpha[25:85, 25:75] = 255
        alpha[25:85, 110:160] = 255
        source = np.full((180, 300, 3), 20, np.uint8)
        source[alpha > 0] = (235, 160, 70)
        raw = np.dstack((source, alpha))
        scope = np.zeros(alpha.shape, bool)
        scope[15:100, 15:95] = True
        transforms, _, report = fit.fit_components(
            Image.fromarray(source), Image.fromarray(raw), required_region=scope,
            fixed_anchor=np.array([[1., 0., 0.], [0., 1., 0.]]))
        self.assertIsNotNone(transforms[0])
        self.assertIsNone(transforms[1])
        self.assertEqual(report["componentEvidence"][1]["status"], "outside_anchored_scope")

    def test_patch_inside_solid_component_cannot_be_treated_as_outside(self):
        alpha = np.zeros((180, 300), np.uint8)
        alpha[20:140, 20:140] = 255
        alpha[25:85, 220:260] = 255
        source = np.full((180, 300, 3), 20, np.uint8)
        source[alpha > 0] = (235, 160, 70)
        scope = np.zeros(alpha.shape, bool)
        scope[70:80, 70:80] = True
        with self.assertRaisesRegex(ValueError, "NATIVE_COMPONENT_SCOPE_EVIDENCE"):
            fit.fit_components(Image.fromarray(source), Image.fromarray(np.dstack((source, alpha))),
                required_region=scope, fixed_anchor=np.array([[1., 0., 0.], [0., 1., 0.]]))

    def fixture(self):
        shapes = []
        for index in range(3):
            alpha = np.zeros((180, 300), np.uint8)
            if index == 0:
                cv2.rectangle(alpha, (25, 25), (75, 85), 255, 5, cv2.LINE_AA)
            elif index == 1:
                cv2.putText(alpha, 'R', (115, 120), cv2.FONT_HERSHEY_SIMPLEX, 2, 255, 7, cv2.LINE_AA)
            else:
                cv2.ellipse(alpha, (240, 55), (25, 16), 0, 0, 360, 255, 3, cv2.LINE_AA)
            shapes.append(alpha)
        expected = np.maximum.reduce(shapes)
        source = np.full((180, 300, 3), 20, np.uint8)
        raw = np.zeros((180, 300, 4), np.uint8)
        colors = [(235, 160, 70), (60, 190, 230), (240, 110, 170)]
        for alpha, color, offset in zip(shapes, colors, [(3, 2), (-2, 3), (2, -3)]):
            weight = alpha[..., None]/255
            source = np.rint(source*(1-weight) + np.array(color)*weight).astype(np.uint8)
            shifted = cv2.warpAffine(alpha, np.array([[1., 0, offset[0]], [0, 1., offset[1]]]), (300, 180))
            raw[shifted > 0, :3] = color
            raw[..., 3] = np.maximum(raw[..., 3], shifted)
        return source, raw, expected

    def check_positions(self, source, raw, expected):
        transforms, anchor, audit = fit.fit_components(Image.fromarray(source), Image.fromarray(raw))
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 300, "height": 180}}
        actual = np.asarray(sampling.sample_components(Image.fromarray(raw), transforms, mapping, (300, 180),
                                                       residual_transform=anchor))[..., 3]
        first, second = expected >= 128, actual >= 128
        self.assertGreater(np.count_nonzero(first & second)/np.count_nonzero(first | second), .90, audit)
        self.assertEqual(sampling.topology(second), (3, 3))
        self.assertEqual(audit["components"], 3)

    def test_independently_shifted_color_blocks_recover_source_positions(self):
        self.check_positions(*self.fixture())

    def test_native_entry_aligns_independently_shifted_blocks(self):
        source, raw, expected = self.fixture()
        native = module("native_entry", "native-rgba-registration.py")
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 300, "height": 180}}
        transform, _ = native.estimate_alignment(Image.fromarray(source), Image.fromarray(raw),
                                                 source_crop=Image.fromarray(source), mapping=mapping)
        result = np.asarray(native.sample_aligned(Image.fromarray(raw), transform, mapping, (300, 180)))
        first, second = expected >= 128, result[..., 3] >= 128
        self.assertGreater(np.count_nonzero(first & second)/np.count_nonzero(first | second), .90)
        self.assertEqual(sampling.topology(second), (3, 3))

    def test_scoped_preview_defers_only_contour_acceptance_not_geometry(self):
        source, raw, _ = self.fixture()
        raw[31:35, 32:75] = (235, 160, 70, 255)
        native = module("native_scoped_entry", "native-rgba-registration.py")
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 300, "height": 180}}
        args = (Image.fromarray(source), Image.fromarray(raw), Image.fromarray(source), mapping)
        with self.assertRaisesRegex(ValueError, "NATIVE_COMPONENT_SOURCE_CONTOUR"):
            native.estimate_component_alignment(*args)
        transform, audit = native.estimate_component_alignment(*args, defer_contour=True)
        self.assertEqual(audit["status"], "pending_scoped_merge")
        self.assertGreater(audit["sourceContour"]["longestUnsupportedRun"], 12)
        sampled = native.sample_aligned(Image.fromarray(raw), transform, mapping, (300, 180))
        self.assertEqual(sampling.topology(np.asarray(sampled)[..., 3] >= 128), (3, 3))

    def scoped_fixture(self, root, repair_defect):
        source, repaired, _ = self.fixture()
        initial = repaired.copy()
        initial[31:35, 32:75] = (235, 160, 70, 255)
        Image.fromarray(source).save(root/"source.png")
        Image.fromarray(initial).save(root/"raw.png")
        Image.fromarray(repaired).save(root/"repair.png")
        (root/"mapping.json").write_text(json.dumps({
            "contentRegion": {"x": 0, "y": 0, "width": 300, "height": 180},
            "canvas": {"width": 300, "height": 180},
            "sourceRegion": {"width": 300, "height": 180},
        }))
        return {"schemaVersion": 2, "route": "reconstruct", "maskProvider": "native_rgba",
                "nativeRgbaRequirements": {"version": 3}, "maximumImagegenCalls": 2,
                "rawCoordinateSpace": "reference_canvas", "removeBackground": True,
                "outputRoot": str(root), "referencePath": str(root/"source.png"),
                "mappingPath": str(root/"mapping.json"), "selectedCropPath": str(root/"source.png"),
                "snapshot": {"bounds": {"x": 0, "y": 0, "width": 300, "height": 180},
                             "strategy": {"repairPaths": [], "fidelityPolicy": "source_faithful_repair",
                                          "localRepairPolicy": "scoped_once_v1"}},
                "scopedNativeRepair": {"rawPath": str(root/"repair.png"),
                    "parentRawSha256": hashlib.sha256((root/"raw.png").read_bytes()).hexdigest(),
                    "rawSha256": hashlib.sha256((root/"repair.png").read_bytes()).hexdigest(),
                    "defects": [repair_defect]}}

    def test_scoped_merge_repairs_initial_contour_before_final_validation(self):
        renderer = module("scoped_renderer", "v2-region-pixels.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.scoped_fixture(root, {"x": 15, "y": 15, "width": 80, "height": 85})
            result, audit = renderer.render_region(manifest, root/"raw.png")
            self.assertTrue(audit["scopedRepair"]["outsideScopeRgbaIdentical"])
            self.assertLessEqual(audit["scopedRepair"]["sourceContour"]["longestUnsupportedRun"], 12)
            self.assertGreaterEqual(audit["scopedRepair"]["sourceContour"]["boundaryMatchRatio"], .9)
            self.assertEqual(audit["scopedRepair"]["nativeAlignment"]["status"], "pending_scoped_merge")
            self.assertEqual(sampling.topology(np.asarray(result)[..., 3] >= 128), (3, 3))

    def test_scope_not_covering_bad_contour_cannot_pass_final_validation(self):
        renderer = module("scoped_renderer_negative", "v2-region-pixels.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.scoped_fixture(root, {"x": 230, "y": 40, "width": 5, "height": 5})
            with self.assertRaisesRegex(ValueError, "SCOPED.*CONTOUR"):
                renderer.render_region(manifest, root/"raw.png")

    def test_irrelevant_repair_component_cannot_block_or_change_scoped_result(self):
        renderer = module("scoped_irrelevant_renderer", "v2-region-pixels.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.scoped_fixture(root, {"x": 15, "y": 15, "width": 80, "height": 85})
            baseline, _ = renderer.render_region(manifest, root/"raw.png")
            repaired = np.array(Image.open(root/"repair.png"))
            # A hallucinated rectangle replaces the far-right ellipse. It
            # cannot enter the permitted left-ring patch and must never be
            # delivered, nor invalidate that independently evidenced repair.
            repaired[:, 200:] = 0
            repaired[35:78, 220:270] = (10, 10, 10, 255)
            Image.fromarray(repaired).save(root/"repair.png")
            manifest["scopedNativeRepair"]["rawSha256"] = hashlib.sha256(
                (root/"repair.png").read_bytes()).hexdigest()
            result, audit = renderer.render_region(manifest, root/"raw.png")
            np.testing.assert_array_equal(np.asarray(result), np.asarray(baseline))
            self.assertTrue(audit["scopedRepair"]["outsideScopeRgbaIdentical"])

    def test_invalid_component_inside_repair_scope_still_fails(self):
        renderer = module("scoped_invalid_renderer", "v2-region-pixels.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.scoped_fixture(root, {"x": 15, "y": 15, "width": 80, "height": 85})
            repaired = np.array(Image.open(root/"repair.png"))
            repaired[:, :95] = 0
            repaired[25:85, 25:75] = (10, 10, 10, 255)
            Image.fromarray(repaired).save(root/"repair.png")
            manifest["scopedNativeRepair"]["rawSha256"] = hashlib.sha256(
                (root/"repair.png").read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "SOURCE_FOREGROUND|SOURCE_EVIDENCE|SCOPED.*CONTOUR"):
                renderer.render_region(manifest, root/"raw.png")

    def test_unmerged_part_of_same_component_cannot_steer_local_patch(self):
        renderer = module("scoped_same_component_renderer", "v2-region-pixels.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.scoped_fixture(root, {"kind": "false_hole", "x": 15, "y": 15,
                                                  "width": 55, "height": 120})
            alpha = np.zeros((180, 300), np.uint8)
            cv2.rectangle(alpha, (30, 30), (210, 140), 255, 10)
            cv2.circle(alpha, (265, 35), 9, 255, -1)
            source = np.full((180, 300, 3), 20, np.uint8)
            source[alpha > 0] = (235, 160, 70)
            source[(alpha > 0) & (np.indices(alpha.shape)[1] > 250)] = (20, 220, 250)
            initial = np.dstack((source, alpha))
            initial[70:73, 29:32, 3] = 0
            corrected = np.dstack((source, alpha))
            # Same connected ring has a changed right side, outside the
            # authorized left-side repair. It is never part of delivery.
            corrected[25:146, 195:250] = 0
            cv2.polylines(corrected, [np.array([[190, 30], [215, 30], [245, 65],
                [210, 105], [235, 140], [190, 140]], np.int32)],
                False, (235, 160, 70, 255), 10)
            for name, values in (("source.png", source), ("raw.png", initial), ("repair.png", corrected)):
                Image.fromarray(values).save(root/name)
            manifest["scopedNativeRepair"]["parentRawSha256"] = hashlib.sha256((root/"raw.png").read_bytes()).hexdigest()
            manifest["scopedNativeRepair"]["rawSha256"] = hashlib.sha256((root/"repair.png").read_bytes()).hexdigest()
            result, audit = renderer.render_region(manifest, root/"raw.png")
            actual = np.asarray(result)
            self.assertGreater(int(actual[71, 30, 3]), 240)
            self.assertTrue(audit["scopedRepair"]["outsideScopeRgbaIdentical"])
            self.assertEqual(sampling.topology(actual[..., 3] >= 128), (2, 1))
            self.assertLessEqual(audit["scopedRepair"]["sourceContour"]["longestUnsupportedRun"], 12)

    def test_manifest_cannot_defer_single_call_contour_validation(self):
        renderer = module("single_call_renderer", "v2-region-pixels.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.scoped_fixture(root, {"x": 15, "y": 15, "width": 80, "height": 85})
            del manifest["scopedNativeRepair"]
            manifest["_defer_component_contour"] = True
            manifest["defer_component_contour"] = True
            with self.assertRaisesRegex(ValueError, "NATIVE_COMPONENT_SOURCE_CONTOUR"):
                renderer.render_region(manifest, root/"raw.png")

    def test_changed_model_color_does_not_override_source_geometry(self):
        source, raw, expected = self.fixture()
        raw[..., :3] = 255-raw[..., :3]
        self.check_positions(source, raw, expected)

    def test_source_shading_does_not_require_flat_model_color_everywhere(self):
        source, raw, expected = self.fixture()
        # A source highlight changes RGB inside half of each shape, without
        # changing its geometry. The model has flattened this shading.
        foreground = expected >= 128
        y, x = np.indices(expected.shape)
        highlight = foreground & (y % 50 < 25)
        source[highlight] = np.clip(source[highlight].astype(int)+65, 0, 255)
        self.check_positions(source, raw, expected)

    def test_two_tone_material_uses_source_color_separation_not_only_texture_edges(self):
        y, x = np.indices((100, 160))
        checker = (((x//4+y//4) % 2)*255).astype(np.uint8)
        source = np.repeat(checker[..., None], 3, axis=2)
        raw = np.zeros((100, 160, 4), np.uint8)
        raw[10:40, 20:60] = (0, 0, 0, 255)
        raw[25:40, 20:60, :3] = (90, 100, 120)
        raw[55:85, 100:140] = (0, 0, 0, 255)
        raw[70:85, 100:140, :3] = (90, 100, 120)
        with self.assertRaisesRegex(ValueError, "SOURCE_FOREGROUND"):
            fit.fit_components(Image.fromarray(source), Image.fromarray(raw))

    def test_two_tone_foreground_keeps_both_material_regions(self):
        source, raw, expected = self.fixture()
        y, _ = np.indices(expected.shape)
        # Two distinct material values, not a flat-color foreground.
        source[expected >= 128] = (5, 10, 15)
        source[(expected >= 128) & (y >= 55)] = (95, 110, 140)
        raw[raw[..., 3] >= 128, :3] = (5, 10, 15)
        raw[(raw[..., 3] >= 128) & (y >= 55), :3] = (95, 110, 140)
        self.check_positions(source, raw, expected)

    def test_nearby_background_hue_keeps_low_contrast_source_shapes(self):
        _, raw, expected = self.fixture()
        weight = expected[..., None]/255
        source = np.rint(np.array([220, 180, 200])*(1-weight)
                        + np.array([240, 200, 220])*weight).astype(np.uint8)
        raw[..., :3] = [240, 200, 220]
        self.check_positions(source, raw, expected)

    def test_weak_source_steps_recover_shapes_without_changing_their_holes(self):
        _, raw, expected = self.fixture()
        weight = expected[..., None]/255
        source = np.rint(np.array([220, 180, 200])*(1-weight)
                        + np.array([228, 188, 208])*weight).astype(np.uint8)
        raw[..., :3] = [228, 188, 208]
        self.check_positions(source, raw, expected)

    def test_weak_background_texture_cannot_replace_missing_source_shapes(self):
        _, raw, _ = self.fixture()
        y, x = np.indices(raw.shape[:2])
        texture = ((x//4+y//4) % 2)*8
        source = (np.array([220, 180, 200])+texture[..., None]).astype(np.uint8)
        raw[..., :3] = [228, 188, 208]
        with self.assertRaisesRegex(ValueError, "COMPONENT_SOURCE"):
            fit.fit_components(Image.fromarray(source), Image.fromarray(raw))

    def test_blank_source_cannot_supply_coordinate_evidence(self):
        raw = np.zeros((100, 160, 4), np.uint8)
        raw[10:30, 20:40] = 255
        raw[60:80, 100:120] = 255
        with self.assertRaisesRegex(ValueError, "COMPONENT_SOURCE_EVIDENCE"):
            fit.fit_components(Image.new("RGB", (160, 100), "white"), Image.fromarray(raw))

    def test_reference_canvas_mismatch_is_rejected_before_fitting(self):
        with self.assertRaisesRegex(ValueError, "COMPONENT_DIMENSIONS"):
            fit.fit_components(Image.new("RGB", (20, 20)), Image.new("RGBA", (40, 40)))

    def test_dense_background_edges_do_not_validate_missing_foreground(self):
        y, x = np.mgrid[:100, :160]
        checker = (((x//4+y//4) % 2)*255).astype(np.uint8)
        source = np.repeat(checker[..., None], 3, axis=2)
        raw = np.zeros((100, 160, 4), np.uint8)
        raw[20:40, 20:50] = 255
        raw[60:80, 100:130] = 255
        with self.assertRaisesRegex(ValueError, "COMPONENT_SOURCE"):
            fit.fit_components(Image.fromarray(source), Image.fromarray(raw))

    def test_equally_plausible_repeated_locations_are_not_guessed(self):
        source = np.full((100, 160, 3), 20, np.uint8)
        raw = np.zeros((100, 160, 4), np.uint8)
        for x in (40, 52, 64):
            source[35:65, x:x+6] = 240
        for x in (46, 58):
            raw[35:65, x:x+6] = (240, 240, 240, 255)
        with self.assertRaises(ValueError):
            fit.fit_components(Image.fromarray(source), Image.fromarray(raw))

    def test_complete_repeated_row_preserves_each_source_instance(self):
        source = np.full((100, 160, 3), 20, np.uint8)
        raw = np.zeros((100, 160, 4), np.uint8)
        expected = np.zeros((100, 160), bool)
        for x in (40, 56, 72):
            source[35:65, x:x+8] = 240
            expected[35:65, x:x+8] = True
            raw[37:67, x+2:x+10] = (240, 240, 240, 255)
        transforms, anchor, _ = fit.fit_components(Image.fromarray(source), Image.fromarray(raw))
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 160, "height": 100}}
        result = np.asarray(sampling.sample_components(Image.fromarray(raw), transforms, mapping, (160, 100),
                                                       residual_transform=anchor))[..., 3] >= 128
        self.assertGreater(np.count_nonzero(result & expected)/np.count_nonzero(result | expected), .95)

if __name__ == "__main__":
    unittest.main()
