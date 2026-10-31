"""Real failed raster: stable contours and counters must survive postprocessing."""
import importlib.util
import hashlib
from pathlib import Path
import unittest

import numpy as np
import cv2
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("source_matte", ROOT / "source-guided-matte.py")
matting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matting)
pixel_spec = importlib.util.spec_from_file_location("pixels", ROOT / "v2-region-pixels.py")
pixels = importlib.util.module_from_spec(pixel_spec)
pixel_spec.loader.exec_module(pixels)


class RealContourRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = ROOT / "fixtures/matte-contours"
        cls.source = Image.open(fixture / "car-text-source.png").convert("RGBA")
        mapping = {"canvas": {"width":1536,"height":1024},
                   "contentRegion":{"x":62,"y":155,"width":1412,"height":713},
                   "sourceRegion":{"width":990,"height":500}}
        cls.proposal = pixels.matte_mask(fixture / "car-text-matte.png", mapping, (990,500), "imagegen_matte")
        cls.alpha, cls.audit, cls.colors = matting.refine_source_matte(cls.source, cls.proposal, "text", recover_foreground=True)
        cls.actual = np.asarray(cls.alpha)

    def test_A_counter_remains_an_area_not_a_single_protected_pixel(self):
        # Hand-inspected interior points; the old output made all three opaque.
        for x,y in [(408,90),(411,94),(414,97)]:
            self.assertLessEqual(int(self.actual[y,x]), 8)
        self.assertGreater(np.count_nonzero(self.actual[79:100,399:419] < 128), 140)

    def test_P_straight_edge_does_not_acquire_jagged_steps(self):
        rows = np.arange(78,142)
        xs = np.array([np.flatnonzero(self.actual[y,80:160] >= 128)[0]+80 for y in rows])
        residual = xs-np.polyval(np.polyfit(rows,xs,1),rows)
        self.assertLess(float(np.sqrt(np.mean(residual**2))), .65)
        self.assertLessEqual(int(np.max(np.abs(np.diff(xs)))), 1)

    def test_all_four_counters_remain_open_after_alpha_recovery(self):
        for x,y in [(170,98),(411,94),(231,283),(832,242)]:
            self.assertLessEqual(int(self.actual[y,x]),8)
        binary = self.actual >= 128
        _, count = nd.label(nd.binary_fill_holes(binary) & ~binary)
        self.assertEqual(count,4)

    def test_opaque_material_and_region_coordinates_are_unchanged(self):
        self.assertEqual(self.alpha.size,(990,500))
        opaque = self.actual == 255
        self.assertGreater(opaque.sum(),100000)
        np.testing.assert_array_equal(np.asarray(self.colors)[opaque], np.asarray(self.source)[opaque,:3])

    def test_local_source_repair_delivers_the_original_failed_crop_without_a_waiver(self):
        self.assertEqual(self.audit['status'], 'passed')
        self.assertLessEqual(self.audit['longestUnsupportedRun'], 12)
        self.assertEqual(self.audit['maximumUnsupportedRun'], 12)
        self.assertEqual(self.audit['minimumRatio'], .90)
        self.assertGreater(self.audit['localContourRepair']['changedPixels'], 0)

    def test_final_contour_integrity_is_audited_not_assumed_from_source_contrast(self):
        self.assertEqual(self.audit["policyVersion"], 7)
        self.assertEqual(self.audit["contourIntegrity"]["status"], "passed")
        self.assertEqual(self.audit["contourIntegrity"]["changedByAlphaRecoveryPixels"], 0)
        self.assertEqual(self.audit["contourIntegrity"]["lostCounterPixels"], 0)
        # Better-looking is not automatically source-aligned. Keep real doubts.
        if self.audit["longestUnsupportedRun"] > 12:
            self.assertEqual(self.audit["status"], "needs_review")

    def test_large_translation_of_real_delivered_letters_returns_to_the_source(self):
        shifted = cv2.warpAffine(self.actual, np.float32([[1, 0, 27], [0, 1, -23]]), self.alpha.size)
        result, audit, colors = matting.refine_source_matte(
            self.source, Image.fromarray(shifted), 'text', recover_foreground=True)
        expected, visible = self.actual >= 128, np.asarray(result) >= 128
        self.assertTrue(audit['globalRegistration']['applied'], audit)
        self.assertEqual(audit['status'], 'passed', audit)
        self.assertGreater(np.count_nonzero(visible & expected) / np.count_nonzero(visible | expected), .995)
        for x, y in [(170, 98), (411, 94), (231, 283), (832, 242)]:
            self.assertLessEqual(result.getpixel((x, y)), 8)
        opaque = np.asarray(result) == 255
        np.testing.assert_array_equal(np.asarray(colors)[opaque], np.asarray(self.source)[opaque, :3])

    def test_uncertainty_has_crop_local_regions_for_inspection_not_a_fake_displacement(self):
        regions = self.audit["uncertainRegions"]
        self.assertGreater(len(regions), 0)
        self.assertLessEqual(len(regions), 5)
        for region in regions:
            self.assertGreater(region["boundaryPixels"], 0)
            self.assertGreaterEqual(region["x"], 0); self.assertGreaterEqual(region["y"], 0)
            self.assertLessEqual(region["x"] + region["width"], 990)
            self.assertLessEqual(region["y"] + region["height"], 500)
        self.assertEqual(regions[0]["boundaryPixels"], self.audit["longestUnsupportedRun"])


class ReflectiveTextRegression(unittest.TestCase):
    def test_soft_and_chromatic_source_evidence_releases_correct_alpha_without_changing_it(self):
        fixture = ROOT / "fixtures/matte-contours"
        source = Image.open(fixture / "reflective-text-source.png").convert("RGBA")
        mapping = {"canvas": {"width": 1536, "height": 1024},
                   "contentRegion": {"x": 62, "y": 161, "width": 1412, "height": 701},
                   "sourceRegion": {"width": 902, "height": 448}}
        proposal = pixels.matte_mask(fixture / "reflective-text-matte.png", mapping, source.size, "imagegen_matte")
        alpha, audit, colors = matting.refine_source_matte(source, proposal, "text", recover_foreground=True)
        self.assertEqual(audit["status"], "passed")
        self.assertGreater(audit["softTransitionBoundaryPixels"], 0)
        self.assertGreater(audit["chromaticBoundaryPixels"], 0)
        self.assertEqual(audit["minimumRatio"], .9)
        self.assertEqual(audit["maximumUnsupportedRun"], 12)
        self.assertEqual(audit["contourIntegrity"]["counterCount"], 4)
        # SHA of alpha from immutable policy-v5 candidate 7a013045: this is
        # a verifier fix, not smoothing, redrawing or a sample-specific mask.
        self.assertEqual(hashlib.sha256(alpha.tobytes()).hexdigest(),
                         "9aa2c54bec4cab4252671d20b61fe8b8d7fe70f081856573abee72ab801b8382")
        opaque = np.asarray(alpha) == 255
        np.testing.assert_array_equal(np.asarray(colors)[opaque], np.asarray(source)[opaque, :3])


class SmallLogoRegression(unittest.TestCase):
    def test_real_small_logo_keeps_antialias_coverage_counters_and_opaque_colors(self):
        fixture = ROOT / "fixtures/matte-contours"
        source = Image.open(fixture / "car-logo-source.png").convert("RGBA")
        mapping = {"canvas": {"width": 1536, "height": 1024},
                   "contentRegion": {"x": 169, "y": 62, "width": 1198, "height": 900},
                   "sourceRegion": {"width": 193, "height": 145}}
        proposal = pixels.matte_mask(fixture / "car-logo-matte.png", mapping, source.size, "imagegen_matte")
        alpha, audit, colors = matting.refine_source_matte(source, proposal, "brand_ui", recover_foreground=True)
        aa = np.asarray(alpha)
        # The point-sampled regression had only 891 soft pixels and stair-stepped
        # arcs. Pin this real case alongside the exact supersampled-ring test.
        self.assertGreater(np.count_nonzero((aa > 8) & (aa < 247)), 1100)
        self.assertLess(np.count_nonzero((aa > 8) & (aa < 247)), 1400)
        self.assertEqual(audit["status"], "passed")
        self.assertEqual(audit["contourIntegrity"]["counterCount"], 2)
        self.assertEqual(alpha.size, (193, 145))
        opaque = aa == 255
        np.testing.assert_array_equal(np.asarray(colors)[opaque], np.asarray(source)[opaque, :3])


class ShapeAlignmentRegression(unittest.TestCase):
    def test_counter_alignment_does_not_distort_an_already_correct_outer_letter(self):
        proposal = np.zeros((110,140),np.uint8)
        proposal[15:95,15:125] = 255
        proposal[40:65,40:80] = 0
        truth = np.zeros_like(proposal)
        truth[15:95,15:125] = 255
        truth[40:65,43:83] = 0
        result = matting.align_component_shape(proposal, truth >= 128, 6)
        np.testing.assert_array_equal(result >= .5, truth >= 128)

    def test_integrity_gate_detects_a_hole_filled_by_final_alpha(self):
        shape = np.zeros((30,40),bool)
        shape[5:25,5:35] = True
        shape[12:18,14:26] = False
        alpha = shape.astype(np.uint8)*255
        alpha[12:18,14:26] = 227
        audit = matting.alpha_contour_integrity(shape,alpha)
        self.assertEqual(audit["status"],"needs_review")
        self.assertEqual(audit["lostCounterPixels"],72)
        self.assertEqual(audit["changedByAlphaRecoveryPixels"],72)

    def test_a_collapsed_observed_hole_does_not_erase_the_clean_counter(self):
        clean = np.zeros((90,100),np.uint8)
        clean[20:70,20:80] = 255
        clean[35:44,35:65] = 0
        observed = clean >= 128
        observed[35:44,35:65] = True
        result = matting.align_component_shape(clean,observed,6)
        np.testing.assert_array_equal(result >= .5, clean >= 128)

    def test_global_source_displacement_does_not_introduce_a_wavy_straight_edge(self):
        clean = np.zeros((110,180),np.uint8)
        clean[25:85,40:140] = 255
        observed = np.zeros_like(clean,dtype=bool)
        for y in range(25,85):
            observed[y,43+(y%3)-1:143+(y%3)-1] = True
        result = matting.align_component_shape(clean,observed,6) >= .5
        ys=np.arange(32,78)
        xs=np.array([np.flatnonzero(result[y])[0] for y in ys])
        self.assertLessEqual(np.ptp(xs),1)
        self.assertLessEqual(abs(xs.mean()-43),1)


if __name__ == "__main__":
    unittest.main()
