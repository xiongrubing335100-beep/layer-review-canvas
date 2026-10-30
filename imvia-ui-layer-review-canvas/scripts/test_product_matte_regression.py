"""Real H5 output: a generated contour is not a pixel-accurate selection."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


matting = module("source_matte", "source-guided-matte.py")
pixels = module("pixels", "v2-region-pixels.py")


class MaterialBoundaryRegression(unittest.TestCase):
    def setUp(self):
        self.visible = np.zeros((100, 140), bool)
        self.visible[20:80, 35:115] = True
        yy, xx = np.indices(self.visible.shape)
        self.rgb = np.repeat((140+xx*.1+yy*.1)[..., None], 3, axis=2)
        # A metal frame: dark first rim, bright highlight, dark inlay, then
        # light opaque material. Non-monotone color is not transparency.
        self.rgb[self.visible] = 235
        self.rgb[20:80, 35] -= 105
        self.rgb[20:80, 37:39] -= 80

    def evidence(self, visible, rgb=None):
        points = np.zeros_like(visible)
        points[35:65] = visible[35:65] & ~nd.binary_erosion(visible)[35:65]
        try:
            _, unsupported = matting.source_contour_evidence(
                self.rgb if rgb is None else rgb, visible, np.zeros_like(visible), material=True)
        except ValueError as error:
            if 'no distinct foreground/background contour evidence' not in str(error):
                raise
            return np.zeros_like(visible)
        return points & (unsupported == 0)

    def test_opaque_metal_rim_is_an_edge_even_when_its_color_is_not_monotone(self):
        self.assertTrue(np.all(self.evidence(self.visible)[35:65, 35]))

    def test_a_displaced_rim_cannot_be_certified_by_a_nearby_highlight(self):
        for shift in (-3, 3):
            moved = np.roll(self.visible, shift, axis=1)
            self.assertFalse(np.any(self.evidence(moved)[35:65, 35+shift]))

    def test_linear_illumination_and_repeating_texture_are_not_material_boundaries(self):
        yy, xx = np.indices(self.visible.shape)
        for field in (140+xx*.3+yy*.1, 140+30*np.sin(xx*1.5)):
            rgb = np.repeat(field[..., None], 3, axis=2)
            self.assertFalse(self.evidence(self.visible, rgb).any())

    def test_a_cast_shadow_cannot_supply_the_extra_material_override(self):
        rgb = np.full((100, 140, 3), 180., dtype=float)
        rgb[:, 30:35] = 165
        rgb[:, 35:115] = 235
        centers = np.column_stack((np.full(30, 30.), np.arange(35, 65)))
        normals = np.tile([1., 0.], (30, 1))
        self.assertFalse(matting.material_profile_support(rgb, centers, normals).any())


class GoldCardRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = ROOT / "fixtures/matte-contours"
        cls.source = Image.open(fixture / "gold-ui-source.png").convert("RGB")
        mapping = {"canvas": {"width": 1536, "height": 1024},
                   "contentRegion": {"x": 62, "y": 252, "width": 1412, "height": 520},
                   "sourceRegion": {"width": 874, "height": 322}}
        cls.proposal = pixels.matte_mask(fixture / "gold-ui-matte.png", mapping,
                                         cls.source.size, "imagegen_matte")
        cls.alpha, cls.audit, cls.colors = matting.refine_source_matte(
            cls.source, cls.proposal, "brand_ui", recover_foreground=True)

    def test_outside_gold_page_is_removed_without_cutting_card_content(self):
        # Source-inspected points, independent of the generated matte/verifier.
        # The model's left edge is x=19; the actual card starts near x=25.
        alpha = np.asarray(self.alpha)
        for x, y in [(20, 100), (20, 160), (20, 220), (400, 305), (400, 20)]:
            self.assertLessEqual(int(alpha[y, x]), 8, (x, y))
        for x, y in [(40, 100), (400, 45), (400, 285), (790, 150), (750, 80)]:
            self.assertEqual(int(alpha[y, x]), 255, (x, y))

    def test_card_text_and_opaque_colors_are_not_redrawn(self):
        self.assertEqual(self.alpha.size, (874, 322))
        opaque = np.asarray(self.alpha) == 255
        np.testing.assert_array_equal(np.asarray(self.colors)[opaque], np.asarray(self.source)[opaque])
        self.assertGreater(int(opaque.sum()), 190000)

    def test_reflective_top_rim_is_not_cut_inward_to_its_brighter_inlay(self):
        alpha = np.asarray(self.alpha)
        # Original-image rim points: the dark/gold lip is part of the card,
        # although the color segmentation prefers the white surface below it.
        for x, y in [(320, 33), (350, 33), (375, 33)]:
            self.assertGreaterEqual(int(alpha[y, x]), 128, (x, y))

    def test_real_card_is_deliverable_without_changing_quality_gates(self):
        self.assertEqual(self.audit["status"], "passed", self.audit)
        self.assertGreaterEqual(self.audit["boundaryMatchRatio"], .9)
        self.assertLessEqual(self.audit["longestUnsupportedRun"], 12)
        self.assertEqual(self.audit["minimumRatio"], .9)
        self.assertEqual(self.audit["maximumUnsupportedRun"], 12)

    def test_an_independent_model_proposal_does_not_cut_the_same_source_rim(self):
        # A second actual model call changed the proposal, not the source. The
        # edge finder must not overfit the first archived generated silhouette.
        mapping = {"canvas": {"width": 1536, "height": 1024},
                   "contentRegion": {"x": 62, "y": 252, "width": 1412, "height": 520},
                   "sourceRegion": {"width": 874, "height": 322}}
        proposal = pixels.matte_mask(ROOT / 'fixtures/matte-contours/gold-ui-regenerated-matte.png',
                                     mapping, self.source.size, 'imagegen_matte')
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels', 'profile': 'material_composite',
                 'objects': [{'name': 'solid card', 'point': [435, 160]}], 'holes': []}
        alpha, audit, colors = matting.refine_source_matte(self.source, proposal, 'brand_ui',
            semantic_topology=guide, recover_foreground=True)
        self.assertEqual(audit['status'], 'passed', audit)
        for x,y in [(320,33),(350,33),(375,33)]:
            self.assertGreaterEqual(alpha.getpixel((x,y)), 128, (x,y))
        for x,y in [(20,100),(400,305),(400,20)]:
            self.assertLessEqual(alpha.getpixel((x,y)), 8, (x,y))
        opaque=np.asarray(alpha)==255
        np.testing.assert_array_equal(np.asarray(colors)[opaque],np.asarray(self.source)[opaque])


if __name__ == "__main__":
    unittest.main()
