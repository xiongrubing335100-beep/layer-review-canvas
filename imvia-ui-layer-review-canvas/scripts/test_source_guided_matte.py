"""Known-alpha regressions: confidence must not stand in for pixel accuracy."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as nd

spec = importlib.util.spec_from_file_location("source_matte", Path(__file__).with_name("source-guided-matte.py"))
matting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matting)


def rectangle():
    alpha = np.zeros((80, 128), np.uint8)
    alpha[20:60, 20:108] = 255
    return alpha


def composite(alpha, foreground=220, background=20):
    mixture = alpha.astype(float)[..., None] / 255
    return Image.fromarray(np.rint(np.broadcast_to(
        foreground * mixture + background * (1 - mixture), (*alpha.shape, 3))).astype(np.uint8))


class TransitionEvidenceTests(unittest.TestCase):
    def test_local_queries_do_not_assert_support_for_unchecked_boundary_pixels(self):
        visible=self.truth>0
        full,unknown=matting.source_contour_evidence(self.rgb,visible,np.zeros_like(visible))
        query=np.zeros_like(visible);query[35:85,35]=True
        checked,local_unknown=matting.source_contour_evidence(
            self.rgb,visible,np.zeros_like(visible),query=query)
        self.assertEqual(checked['boundaryPixels'],50)
        np.testing.assert_array_equal(local_unknown[query]>0,unknown[query]>0)
        self.assertFalse(local_unknown[~query].any())

    def setUp(self):
        self.truth = np.zeros((120, 180), np.uint8)
        self.truth[20:100, 35:145] = 255
        soft = np.asarray(Image.fromarray(self.truth).filter(ImageFilter.GaussianBlur(3)))
        self.rgb = np.asarray(composite(soft))

    def evidence(self, visible, rgb=None):
        boundary = visible & ~nd.binary_erosion(visible)
        return matting.soft_transition_evidence(self.rgb if rgb is None else rgb, visible, boundary)

    def test_soft_edge_center_is_supported_independently_of_local_gradient_noise(self):
        evidence = self.evidence(self.truth > 0)
        self.assertTrue(np.all(evidence[35:85, 35]))

    def test_three_pixel_registration_error_is_not_certified_by_a_nearby_soft_edge(self):
        for shift in (-3, 3):
            with self.subTest(shift=shift):
                visible = np.roll(self.truth > 0, shift, axis=1)
                evidence = self.evidence(visible)
                self.assertFalse(np.any(evidence[35:85, 35+shift]))

    def test_smooth_illumination_without_an_object_step_is_not_edge_evidence(self):
        yy, xx = np.indices(self.truth.shape)
        rgb = np.repeat((60 + xx*.7 + yy*.15)[..., None], 3, axis=2).round().astype(np.uint8)
        self.assertFalse(self.evidence(self.truth > 0, rgb).any())

    def test_repeating_texture_is_not_certified_as_a_soft_object_boundary(self):
        yy, xx = np.indices(self.truth.shape)
        rgb = np.repeat((100 + 35*np.sin(xx*1.5) + 10*np.cos(yy))[..., None], 3, axis=2).round().astype(np.uint8)
        self.assertFalse(self.evidence(self.truth > 0, rgb).any())


class ChromaticEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.visible = np.zeros((120,180), bool)
        self.visible[20:100,35:145] = True
        self.boundary = self.visible & ~nd.binary_erosion(self.visible)
        yy, xx = np.indices(self.visible.shape)
        light = 130 + 30*np.sin(xx*1.5) + 10*np.cos(yy)
        self.rgb = np.repeat(light[...,None],3,axis=2)
        self.rgb[...,2] += self.visible*20

    def test_reflection_does_not_hide_a_source_measured_color_edge(self):
        evidence = matting.chromatic_contour_evidence(self.rgb, self.visible, self.boundary)
        self.assertTrue(np.all(evidence[30:90,35]))

    def test_color_edge_does_not_certify_a_three_pixel_displacement(self):
        for shift in (-3,3):
            visible = np.roll(self.visible,shift,axis=1)
            evidence = matting.chromatic_contour_evidence(self.rgb, visible, visible & ~nd.binary_erosion(visible))
            self.assertFalse(np.any(evidence[30:90,35+shift]))

    def test_luminance_or_chromatic_texture_alone_is_not_contour_evidence(self):
        yy, xx = np.indices(self.visible.shape)
        for channel in (None, 2):
            rgb = np.repeat((130+30*np.sin(xx*1.5)+10*np.cos(yy))[...,None],3,axis=2)
            if channel is not None:
                rgb[...,channel] += 20*np.sin(xx*1.5)
            self.assertFalse(matting.chromatic_contour_evidence(rgb, self.visible, self.boundary).any())


class PatchEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.visible = np.zeros((72, 80), bool)
        self.visible[22:54, 24:59] = True
        self.points = np.zeros_like(self.visible)
        self.points[22, 24:30] = True
        self.points[23:29, 24] = True
        soft = nd.gaussian_filter(self.visible.astype(float), 1.5)
        yy, xx = np.indices(self.visible.shape)
        background = np.stack((90+xx*.2, 100+yy*.15, 130+xx*.1), axis=2)
        self.rgb = np.rint(background + soft[...,None]*np.array([50,35,60])).astype(np.uint8)

    def test_two_dimensional_source_fit_recognizes_a_soft_corner(self):
        evidence = matting.patch_contour_evidence(self.rgb, self.visible, self.points)
        self.assertTrue(np.all(evidence[self.points]))

    def test_displaced_corner_is_not_certified_by_the_nearby_source_corner(self):
        for dx,dy in [(3,0),(-3,0),(0,3),(0,-3)]:
            visible = np.roll(self.visible,(dy,dx),axis=(0,1))
            points = np.roll(self.points,(dy,dx),axis=(0,1))
            evidence = matting.patch_contour_evidence(self.rgb, visible, points)
            self.assertFalse(evidence.any(), (dx,dy))

    def test_color_texture_and_lighting_do_not_supply_a_false_corner(self):
        yy, xx = np.indices(self.visible.shape)
        for field in (100+xx*.3+yy*.15, 120+30*np.sin(xx*1.5)+20*np.cos(yy)):
            rgb=np.repeat(field[...,None],3,axis=2)
            self.assertFalse(matting.patch_contour_evidence(rgb,self.visible,self.points).any())


class LocalContourRepairTests(unittest.TestCase):
    def test_source_alignment_preserves_a_straight_edge_instead_of_copying_jagged_segmentation(self):
        alpha = np.zeros((100,140),np.uint8); alpha[20:80,35:110]=255
        observed=alpha>=128
        observed[:]=False
        for y in range(20,80): observed[y,37+(y%3)-1:110]=True
        uncertain=np.zeros_like(observed); uncertain[30:70,35]=True
        repaired=matting.align_uncertain_segments(alpha,observed,uncertain)
        xs=np.array([np.flatnonzero(repaired[y]>=128)[0] for y in range(30,70)])
        self.assertLessEqual(np.ptp(xs),1)
        self.assertLessEqual(abs(float(xs.mean())-37),1)
        np.testing.assert_array_equal(repaired[30:70,60:110],alpha[30:70,60:110])

    def test_unrelated_distant_shape_cannot_drag_the_contour(self):
        alpha=np.zeros((100,140),np.uint8); alpha[20:80,35:110]=255
        observed=np.roll(alpha>=128,18,axis=1)
        uncertain=np.zeros_like(observed); uncertain[30:70,35]=True
        repaired=matting.align_uncertain_segments(alpha,observed,uncertain)
        np.testing.assert_array_equal(repaired,alpha)


class SourceMatteTests(unittest.TestCase):
    def test_exact_soft_contour_on_reflective_background_is_not_its_own_noise(self):
        # Known alpha, not a model proposal or a score computed by the verifier.
        # A 7px noise window used to contain the whole soft transition and
        # reject every boundary pixel even though the final contour is exact.
        yy, xx = np.indices((120, 180))
        hard = np.zeros((120, 180), np.uint8)
        hard[20:100, 35:145] = 255
        truth = np.asarray(Image.fromarray(hard).filter(ImageFilter.GaussianBlur(3)))
        background = np.stack((130 + 20*np.sin(yy/9), 90 + 20*np.cos(xx/11),
                               100 + 15*np.sin((yy+xx)/13)), axis=2)
        mixture = truth[..., None] / 255
        source = np.rint(background*(1-mixture) + np.array([220,185,210])*mixture).astype(np.uint8)
        alpha, audit = matting.refine_source_matte(Image.fromarray(source), Image.fromarray(truth), "text")
        np.testing.assert_array_equal(np.asarray(alpha) >= 128, truth >= 128)
        self.assertEqual(audit["status"], "passed", "a correct soft contour must not be rejected as noise")

    def refine(self, truth, proposal=None, foreground=220, background=20):
        return matting.refine_source_matte(composite(truth, foreground, background),
                                          Image.fromarray(truth if proposal is None else proposal), "text")

    def test_exact_low_contrast_mask_is_not_rejected_as_bad_geometry(self):
        truth = rectangle()
        alpha, audit = self.refine(truth, foreground=115, background=100)
        np.testing.assert_array_equal(np.asarray(alpha), truth)
        self.assertEqual(audit["status"], "passed")

    def test_soft_edge_alpha_is_recovered_without_thresholding_its_tails(self):
        truth = np.asarray(Image.fromarray(rectangle()).filter(ImageFilter.GaussianBlur(2)))
        for contrast in (80, 200):
            with self.subTest(contrast=contrast):
                alpha, _ = self.refine(truth, foreground=20+contrast, background=20)
                self.assertLessEqual(np.abs(np.asarray(alpha).astype(float)-truth).max(), 2)

    def test_four_pixel_text_offset_is_corrected_in_source_coordinates(self):
        truth = rectangle()
        shifted = np.zeros_like(truth)
        shifted[:, 4:] = truth[:, :-4]
        alpha, audit = self.refine(truth, shifted)
        np.testing.assert_array_equal(np.asarray(alpha), truth)
        self.assertEqual(audit["status"], "passed")

    def test_missing_component_is_flagged_not_added_or_certified_complete(self):
        truth = np.zeros((80, 128), np.uint8)
        truth[20:60, 20:45] = 255
        truth[20:60, 75:100] = 255
        proposal = truth.copy()
        proposal[:, 75:100] = 0
        alpha, audit = self.refine(truth, proposal)
        self.assertEqual(audit["status"], "needs_review")
        self.assertIn("POSSIBLE_MISSING_COMPONENTS", audit["reviewReasons"])
        self.assertEqual(audit["unselectedComponentCount"], 1)
        self.assertEqual(np.asarray(alpha)[30, 80], 0, "never invent a new selected object")

    def test_source_hole_is_restored_even_when_the_proposal_fills_it(self):
        truth = rectangle()
        truth[28:52, 30:98] = 0
        alpha, audit = self.refine(truth, rectangle())
        np.testing.assert_array_equal(np.asarray(alpha), truth)
        self.assertEqual(audit["status"], "passed")

    def test_flat_source_and_distant_object_cannot_supply_false_alignment(self):
        with self.assertRaisesRegex(ValueError, "MATTE_SOURCE_GEOMETRY_MISMATCH"):
            self.refine(rectangle(), foreground=100, background=100)
        truth = np.zeros((80, 128), np.uint8)
        truth[20:60, 10:40] = 255
        proposal = np.zeros_like(truth)
        proposal[20:60, 80:110] = 255
        with self.assertRaisesRegex(ValueError, "MATTE_SOURCE_GEOMETRY_MISMATCH"):
            self.refine(truth, proposal)

    def test_local_contrast_on_a_gradient_background_does_not_depend_on_global_text_color(self):
        truth = np.zeros((120, 180), np.uint8)
        truth[20:45, 20:70] = 255
        truth[65:100, 100:155] = 255
        yy, xx = np.indices(truth.shape)
        background = np.stack((90 + xx * .3, 80 + yy * .25, 110 + xx * .1), axis=2)
        foreground = background.copy()
        foreground[:55] += 16
        foreground[55:] -= 50
        source = np.where(truth[..., None] > 0, foreground, background).round().astype(np.uint8)
        shifted = np.zeros_like(truth)
        shifted[:, 3:] = truth[:, :-3]
        alpha, audit = matting.refine_source_matte(Image.fromarray(source), Image.fromarray(shifted), "text")
        actual = np.asarray(alpha) >= 128
        self.assertGreater((actual & (truth > 0)).sum() / (actual | (truth > 0)).sum(), .995)
        self.assertEqual(audit["status"], "passed")

    def test_missing_hole_on_a_gradient_is_not_locked_as_sure_foreground(self):
        proposal = rectangle()
        truth = proposal.copy()
        truth[30:42, 35:65] = 0
        yy, xx = np.indices(truth.shape)
        background = 100 + xx*.3 + yy*.1
        source = np.repeat((background + (truth > 0)*20)[..., None], 3, axis=2).round().astype(np.uint8)
        alpha, _ = matting.refine_source_matte(Image.fromarray(source), Image.fromarray(proposal), "text")
        self.assertEqual(np.asarray(alpha)[35, 50], 0)
        self.assertEqual(np.asarray(alpha)[50, 50], 255)

    def test_opaque_interior_shading_is_not_mistaken_for_transparency(self):
        truth = rectangle()
        color = np.where(truth > 0, 220, 20).astype(np.uint8)
        color[35:45, 40:60] = 150
        source = Image.fromarray(np.repeat(color[..., None], 3, axis=2))
        alpha, _ = matting.refine_source_matte(source, Image.fromarray(truth), "text")
        np.testing.assert_array_equal(np.asarray(alpha), truth)

    def test_thin_existing_hole_survives_bounded_refinement_on_a_mixed_background(self):
        # The narrow background island has no pixel farther than radius=6
        # from foreground. It still needs its own background seed, like a thin
        # foreground stroke does. A gradient plus a reflection forces the
        # bounded route instead of the simple color-projection shortcut.
        truth = np.zeros((100, 160), np.uint8)
        truth[20:80, 30:130] = 255
        truth[43:51, 60:95] = 0
        yy, xx = np.indices(truth.shape)
        background = np.stack((250 + xx*.005, 160 + yy*.05, 130 + xx*.07), axis=2)
        background[xx < 28] = [245, 145, 40]
        soft = np.asarray(Image.fromarray(truth).filter(ImageFilter.GaussianBlur(1))) / 255
        source = np.rint(background*(1-soft[..., None]) + np.array([250, 196, 215])*soft[..., None]).astype(np.uint8)
        alpha, audit = matting.refine_source_matte(Image.fromarray(source), Image.fromarray(truth), "text")
        self.assertEqual(np.asarray(alpha)[47, 75], 0, "the existing hole must not be filled by refinement")
        self.assertEqual(np.asarray(alpha)[65, 75], 255, "the opaque body must remain")
        visible = np.asarray(alpha) >= 128
        self.assertGreater((visible & (truth > 0)).sum() / (visible | (truth > 0)).sum(), .99)
        self.assertEqual(audit["status"], "passed", "a verified soft contour must not count as its own background noise")

    def test_uncertain_geometry_is_retained_as_a_diagnostic_not_certified(self):
        truth = rectangle()
        # A legitimate opaque material pattern violates the simple color model.
        # No distinct source contour exists: the result must stay unverified,
        # not be lost as a generation error or stamped as an accurate cutout.
        yy, xx = np.indices(truth.shape)
        source = np.repeat((100 + (xx % 5) + (yy % 7))[..., None], 3, axis=2).astype(np.uint8)
        alpha, audit = matting.refine_source_matte(Image.fromarray(source), Image.fromarray(truth), "text")
        self.assertEqual(alpha.size, (128, 80))
        self.assertEqual(audit["status"], "needs_review")
        self.assertIn("SOURCE_BOUNDARY_UNCERTAIN", audit["reviewReasons"])


if __name__ == "__main__":
    unittest.main()
