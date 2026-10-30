import importlib.util
from pathlib import Path
import unittest
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("registration", Path(__file__).with_name("component-rgba-sampling.py"))
registration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registration)


class ComponentSamplingTests(unittest.TestCase):
    def fractional_gap(self):
        raw = np.zeros((20, 20, 4), np.uint8)
        raw[3:7, 4:14] = [220, 80, 30, 255]
        raw[8:12, 4:14] = [30, 80, 220, 255]
        transforms = [np.array([[1., 0, 0], [0, 1., .46875]]),
                      np.array([[1., 0, 0], [0, 1., -.03125]])]
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 20, "height": 20}}
        return Image.fromarray(raw), transforms, mapping

    def test_scoped_intermediate_ignores_soft_contact_wholly_outside_merge_scope(self):
        raw, transforms, mapping = self.fractional_gap()
        scope = np.zeros((20, 20), bool)
        scope[10:12, 4:14] = True
        actual = np.asarray(registration.sample_components(
            raw, transforms, mapping, (20, 20), allow_partial=True, required_region=scope))
        # No alpha erasure: intermediate still contains summed coverage.
        self.assertEqual(int(actual[7, 5, 3]), 128)
        self.assertEqual(actual[10, 5].tolist(), [30, 80, 220, 255])

    def test_soft_contact_in_authorized_patch_still_rejects(self):
        raw, transforms, mapping = self.fractional_gap()
        scope = np.zeros((20, 20), bool)
        scope[7, 4:14] = True
        with self.assertRaisesRegex(ValueError, "COMPONENT_TOPOLOGY"):
            registration.sample_components(raw, transforms, mapping, (20, 20),
                                           allow_partial=True, required_region=scope)

    def test_ordinary_sampling_cannot_ignore_soft_contact(self):
        raw, transforms, mapping = self.fractional_gap()
        with self.assertRaisesRegex(ValueError, "COMPONENT_TOPOLOGY"):
            registration.sample_components(raw, transforms, mapping, (20, 20))

    def fixture(self):
        raw = np.zeros((24, 40, 4), np.uint8)
        raw[3:12, 3:12] = [230, 160, 50, 255]
        raw[5:10, 5:10] = 0
        raw[15, 24:35] = [30, 80, 220, 255]
        raw[14, 24:35] = [30, 80, 220, 64]
        mapping = {"contentRegion": {"x": 0, "y": 0, "width": 40, "height": 24}}
        return raw, mapping

    def test_identity_preserves_every_rgba_pixel_including_soft_edge_and_hole(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[1., 0, 0], [0, 1., 0]])]*2
        actual = registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))
        np.testing.assert_array_equal(np.asarray(actual), raw)

    def test_independent_integer_translation_moves_color_and_alpha_together(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[1., 0, 2], [0, 1., 1]]),
                      np.array([[1., 0, -3], [0, 1., 2]])]
        expected = np.zeros_like(raw)
        expected[4:13, 5:14] = raw[3:12, 3:12]
        expected[16:18, 21:32] = raw[14:16, 24:35]
        actual = registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))
        np.testing.assert_array_equal(np.asarray(actual), expected)

    def test_collision_is_rejected_instead_of_merging_letters(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[1., 0, 0], [0, 1., 0]]),
                      np.array([[1., 0, -20], [0, 1., -10]])]
        with self.assertRaisesRegex(ValueError, "COMPONENT_OVERLAP"):
            registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))

    def test_clipping_a_component_is_rejected(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[1., 0, -30], [0, 1., 0]]),
                      np.array([[1., 0, 0], [0, 1., 0]])]
        with self.assertRaisesRegex(ValueError, "COMPONENT_CLIPPED"):
            registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))

    def test_missing_transform_cannot_silently_discard_a_component(self):
        raw, mapping = self.fixture()
        with self.assertRaisesRegex(ValueError, "COMPONENT_COUNT"):
            registration.sample_components(Image.fromarray(raw), [], mapping, (40, 24))

    def test_partial_transform_is_never_accepted_for_an_ordinary_result(self):
        raw, mapping = self.fixture()
        with self.assertRaisesRegex(ValueError, "COMPONENT_GEOMETRY"):
            registration.sample_components(Image.fromarray(raw),
                [np.array([[1., 0, 0], [0, 1., 0]]), None], mapping, (40, 24))

    def test_explicit_partial_sampling_preserves_complete_requested_component(self):
        raw, mapping = self.fixture()
        actual = registration.sample_components(Image.fromarray(raw),
            [np.array([[1., 0, 0], [0, 1., 0]]), None], mapping, (40, 24), allow_partial=True)
        expected = np.zeros_like(raw)
        expected[3:12, 3:12] = raw[3:12, 3:12]
        np.testing.assert_array_equal(np.asarray(actual), expected)

    def test_reflection_cannot_reverse_text(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[-1., 0, 18], [0, 1., 0]]),
                      np.array([[1., 0, 0], [0, 1., 0]])]
        with self.assertRaisesRegex(ValueError, "COMPONENT_GEOMETRY"):
            registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))

    def test_touching_without_overlap_cannot_join_separate_letters(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[1., 0, 0], [0, 1., 0]]),
                      np.array([[1., 0, -12], [0, 1., -12]])]
        with self.assertRaisesRegex(ValueError, "COMPONENT_TOPOLOGY"):
            registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))

    def test_downsampling_cannot_silently_remove_a_thin_line(self):
        raw, mapping = self.fixture()
        transforms = [np.array([[1., 0, 0], [0, 1., 0]]),
                      np.array([[.1, 0, 20], [0, .1, 15]])]
        with self.assertRaisesRegex(ValueError, "COMPONENT_TOPOLOGY"):
            registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))

    def test_detached_translucent_material_requires_its_own_coordinate_evidence(self):
        raw, mapping = self.fixture()
        raw[1, 30] = [240, 210, 120, 70]
        transforms = [np.array([[1., 0, 0], [0, 1., 0]])]*2
        with self.assertRaisesRegex(ValueError, "COMPONENT_UNANCHORED_ALPHA"):
            registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24))

    def test_valid_global_anchor_preserves_detached_soft_pixels_without_nearest_letter_assignment(self):
        raw, mapping = self.fixture()
        raw[1, 30] = [240, 210, 120, 70]
        transforms = [np.array([[1., 0, 0], [0, 1., 0]])]*2
        actual = registration.sample_components(Image.fromarray(raw), transforms, mapping, (40, 24),
                                                residual_transform=transforms[0])
        np.testing.assert_array_equal(np.asarray(actual), raw)


if __name__ == "__main__":
    unittest.main()
