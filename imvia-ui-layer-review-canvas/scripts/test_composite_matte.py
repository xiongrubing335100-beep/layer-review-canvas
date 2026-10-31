"""Known source alpha, not the processor's score, is the contour oracle."""
import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('matting', ROOT / 'source-guided-matte.py')
matting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matting)


class CompositeContours(unittest.TestCase):
    def fixture(self, scale=1, shift=0):
        # A thin reflective ring joined to a solid, shaded body. Proposal has
        # the correct objects but incorrectly thickens the outside of the ring.
        h, w = 240*scale, 300*scale
        y, x = np.indices((h, w))
        cx, cy = (150+shift)*scale, 105*scale
        r = np.hypot(x-cx, y-cy)
        truth = ((r >= 63*scale) & (r <= 70*scale))
        truth[100*scale:200*scale, (115+shift)*scale:(185+shift)*scale] = True
        proposal = (r >= 63*scale) & (r <= 85*scale)
        proposal[100*scale:200*scale, (115+shift)*scale:(185+shift)*scale] = True
        rgb = np.stack((210+x*.02, 215+y*.02, 220+x*.01), axis=2)
        rgb[truth] = [170, 105, 35]
        rgb[truth & (r > 67*scale)] = [245, 210, 120]
        rgb[125*scale:150*scale, (115+shift)*scale:(185+shift)*scale] = [45, 35, 25]
        return Image.fromarray(np.uint8(rgb)), Image.fromarray(np.uint8(proposal)*255), truth

    def refine(self, source, proposal, point):
        spec = importlib.util.spec_from_file_location('semantic', ROOT / 'semantic-matte.py')
        semantic = importlib.util.module_from_spec(spec); spec.loader.exec_module(semantic)
        _, holes = semantic.hole_components(proposal)
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels', 'profile': 'material_composite',
                 'objects': [{'name': 'ring and shaded body', 'point': point}],
                 'holes': [{'id': h['id'], 'treatment': 'preserve', 'reason': 'visible source background'} for h in holes]}
        return matting.refine_source_matte(source, proposal, 'text', semantic_topology=guide, recover_foreground=True)

    def test_source_can_remove_a_thickened_ring_without_erasing_opaque_material(self):
        for scale, shift in [(1, 0), (2, -10)]:
            source, proposal, truth = self.fixture(scale, shift)
            alpha, audit, rgb = self.refine(source, proposal, [(150+shift)*scale, 140*scale])
            visible = np.asarray(alpha) >= 128
            iou = np.count_nonzero(visible & truth) / np.count_nonzero(visible | truth)
            self.assertGreater(iou, .98, (scale, iou, audit))
            self.assertEqual(audit['status'], 'passed', audit)
            self.assertTrue(np.all(np.asarray(alpha)[130*scale:140*scale, (120+shift)*scale:(180+shift)*scale] == 255))
            opaque = np.asarray(alpha) == 255
            np.testing.assert_array_equal(np.asarray(rgb)[opaque], np.asarray(source)[opaque])

    def test_nearby_unrequested_object_is_not_added_by_source_segmentation(self):
        source, proposal, truth = self.fixture()
        rgb = np.asarray(source).copy(); rgb[20:55, 260:285] = [170, 105, 35]
        alpha, _, _ = self.refine(Image.fromarray(rgb), proposal, [150, 140])
        self.assertFalse(np.any(np.asarray(alpha)[20:55, 260:285]))

    def test_large_whole_assembly_offset_is_recovered_before_local_refinement(self):
        source, _, truth = self.fixture()
        # The geometry is correct, but the model moved the entire assembly.
        # Ground truth comes from the independently constructed source alpha.
        for dx, dy in [(0, -28), (24, 0), (-18, 23)]:
            with self.subTest(dx=dx, dy=dy):
                proposal = cv2.warpAffine(truth.astype(np.uint8)*255,
                    np.float32([[1, 0, dx], [0, 1, dy]]), source.size)
                alpha, audit, _ = self.refine(source, Image.fromarray(proposal), [150, 140])
                visible = np.asarray(alpha) >= 128
                self.assertGreater(np.count_nonzero(visible & truth) / np.count_nonzero(visible | truth), .99)
                self.assertEqual(audit['status'], 'passed', audit)
                self.assertLessEqual(np.max(nd.distance_transform_edt(~truth)[visible]), 1)
                self.assertLessEqual(np.max(nd.distance_transform_edt(~visible)[truth]), 1)

    def test_uniform_source_cannot_certify_the_proposed_assembly(self):
        _, proposal, _ = self.fixture()
        source = Image.new('RGB', proposal.size, (200, 200, 200))
        with self.assertRaisesRegex(ValueError, 'MATTE_SOURCE_GEOMETRY_MISMATCH'):
            self.refine(source, proposal, [150, 140])


class SourceAssemblyTopology(unittest.TestCase):
    def ring(self, broken_sides=1, source_gap=False):
        y, x = np.indices((220, 240))
        radius = np.hypot(x-120, y-110)
        truth = (radius <= 72) & (radius >= 50)
        proposal = truth.copy()
        proposal[102:119, :121 if broken_sides == 1 else 240] = False
        if source_gap:
            truth = proposal.copy()
        rgb = np.dstack((210+x*.03, 200+y*.02, 190+x*.02)).astype(np.uint8)
        rgb[truth] = [150, 80, 30]
        evidence = (np.zeros(truth.shape, np.int32), np.zeros(truth.shape, bool),
                    [{'name': 'upper ring', 'point': [120, 45]},
                     {'name': 'lower ring', 'point': [120, 175]}])
        return rgb, proposal, truth, evidence

    def segment(self, rgb, proposal, evidence):
        return matting.source_assembly_matte(Image.fromarray(rgb),
            Image.fromarray(np.uint8(proposal)*255), np.ones(proposal.shape, bool), evidence)

    def test_reconnected_ring_preserves_background_that_becomes_an_enclosed_hole(self):
        # The independently drawn source has a complete ring. The proposal has
        # no enclosed hole. A new background hole is a correction, not damage.
        rgb, proposal, truth, evidence = self.ring()
        result = self.segment(rgb, proposal, evidence)
        self.assertIsNotNone(result, 'a verified ring must not be rejected for gaining its true hole')
        alpha, audit, colors = result
        np.testing.assert_array_equal(np.asarray(alpha) >= 128, truth)
        self.assertEqual(alpha.getpixel((120, 110)), 0)
        self.assertEqual(alpha.getpixel((50, 110)), 255)
        self.assertEqual(audit['status'], 'passed')
        np.testing.assert_array_equal(np.asarray(colors)[truth], rgb[truth])

    def test_two_proposal_fragments_can_reconnect_without_losing_either_source_part(self):
        rgb, proposal, truth, evidence = self.ring(broken_sides=2)
        self.assertEqual(nd.label(proposal)[1], 2)
        result = self.segment(rgb, proposal, evidence)
        self.assertIsNotNone(result, 'two mistaken fragments may belong to one source object')
        np.testing.assert_array_equal(np.asarray(result[0]) >= 128, truth)
        self.assertEqual(result[1]['status'], 'passed')

    def test_real_source_gap_is_not_closed_just_to_make_a_ring(self):
        rgb, proposal, truth, evidence = self.ring(broken_sides=2, source_gap=True)
        result = self.segment(rgb, proposal, evidence)
        self.assertIsNotNone(result)
        np.testing.assert_array_equal(np.asarray(result[0]) >= 128, truth)
        self.assertEqual(nd.label(np.asarray(result[0]) >= 128)[1], 2)

    def test_reconnection_survives_the_public_refinement_and_semantic_pipeline(self):
        # Multiple opaque material colors exclude the single-color shortcut.
        # Verify the public producer path, not just the segmentation helper.
        for sides in (1, 2):
            with self.subTest(broken_sides=sides):
                rgb, proposal, truth, evidence = self.ring(sides)
                y, _ = np.indices(truth.shape)
                rgb[truth & (y < 100)] = [240, 190, 70]
                rgb[truth & (y > 155)] = [70, 50, 20]
                guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                         'profile': 'material_composite', 'objects': evidence[2], 'holes': []}
                alpha, audit, colors = matting.refine_source_matte(
                    Image.fromarray(rgb), Image.fromarray(np.uint8(proposal)*255),
                    'brand_ui', semantic_topology=guide, recover_foreground=True)
                np.testing.assert_array_equal(np.asarray(alpha) >= 128, truth)
                self.assertEqual(audit['status'], 'passed')
                self.assertEqual(audit['semanticTopology']['status'], 'passed')
                opaque = np.asarray(alpha) == 255
                np.testing.assert_array_equal(np.asarray(colors)[opaque], rgb[opaque])

    def test_part_tracking_rejects_lost_split_and_new_islands(self):
        proposal = np.zeros((80, 110), bool)
        proposal[10:70, 10:40] = True
        proposal[10:70, 60:90] = True
        self.assertTrue(matting.preserves_assembly_parts(proposal, proposal, 6))
        lost = proposal.copy(); lost[:, 60:90] = False
        split = proposal.copy(); split[39:42, 10:40] = False
        invented = proposal.copy(); invented[30:40, 99:105] = True
        for name, visible in [('lost', lost), ('split', split), ('invented', invented)]:
            with self.subTest(name=name):
                self.assertFalse(matting.preserves_assembly_parts(proposal, visible, 6))


if __name__ == '__main__':
    unittest.main()
