"""Registration tests use independently known geometry, not its fitting score."""
import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location('registration', Path(__file__).with_name('matte-registration.py'))
registration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registration)


class GlobalRegistration(unittest.TestCase):
    def fixture(self):
        alpha = np.zeros((260, 340), np.uint8)
        cv2.ellipse(alpha, (165, 125), (80, 75), 0, 0, 360, 255, -1)
        alpha[105:137, 155:210] = 0
        alpha[165:215, 125:180] = 255
        alpha[45:49, 254:259] = 255
        yy, xx = np.indices(alpha.shape)
        background = np.stack((200+xx*.02, 180+yy*.02, 150+xx*.02), axis=2)
        rgb = background.copy()
        rgb[alpha > 0] = [55, 90, 150]
        rgb[80:90, 130:160] = [90, 120, 220]
        return Image.fromarray(rgb.astype(np.uint8)), Image.fromarray(alpha)

    def test_aligned_coverage_and_disconnected_small_details_are_byte_stable(self):
        source, mask = self.fixture()
        result, audit, matrix = registration.register_matte(source, mask)
        self.assertEqual(result.tobytes(), mask.tobytes())
        self.assertFalse(audit['applied'])
        self.assertIsNone(matrix)

    def test_large_translation_preserves_holes_and_every_small_component(self):
        source, truth = self.fixture()
        for dx,dy in [(31,-23),(-28,29),(0,32)]:
            with self.subTest(dx=dx, dy=dy):
                mask = Image.fromarray(cv2.warpAffine(np.asarray(truth),
                    np.float32([[1,0,dx],[0,1,dy]]), truth.size))
                result, audit, _ = registration.register_matte(source, mask)
                self.assertTrue(audit['applied'], audit)
                self.assertEqual(result.tobytes(), truth.tobytes())

    def test_flat_source_cannot_invent_an_alignment(self):
        _, mask = self.fixture()
        source = Image.new('RGB', mask.size, (180,180,180))
        result, audit, _ = registration.register_matte(source, mask)
        self.assertFalse(audit['applied'], audit)
        self.assertEqual(result.tobytes(), mask.tobytes())

    def test_alignment_cannot_clip_a_small_disconnected_attachment(self):
        source, truth = self.fixture()
        moved = cv2.warpAffine(np.asarray(truth), np.float32([[1,0,-25],[0,1,0]]), truth.size)
        moved[190:193, 337:340] = 255
        mask = Image.fromarray(moved)
        result, audit, _ = registration.register_matte(source, mask)
        self.assertFalse(audit['applied'], audit)
        self.assertEqual(audit['reason'], 'would_clip_content')
        self.assertEqual(result.tobytes(), mask.tobytes())

    def test_shared_small_scale_and_rotation_are_not_left_as_local_shape_errors(self):
        source, truth = self.fixture()
        matrix = cv2.getRotationMatrix2D((165,125), 1.4, 1.025)
        matrix[:,2] += [22,-18]
        moved = cv2.warpAffine(np.asarray(truth), matrix, truth.size, flags=cv2.INTER_LINEAR)
        result, audit, _ = registration.register_matte(source, Image.fromarray(moved))
        visible, expected = np.asarray(result) >= 128, np.asarray(truth) >= 128
        self.assertGreater(np.count_nonzero(visible & expected)/np.count_nonzero(visible | expected), .985, audit)

    def test_repeated_indistinguishable_objects_do_not_choose_an_arbitrary_target(self):
        alpha = np.zeros((200,300),np.uint8)
        alpha[60:140,110:155] = 255
        rgb = np.full((200,300,3),190,np.uint8)
        rgb[60:140,80:125] = [50,80,120]
        rgb[60:140,140:185] = [50,80,120]
        result, audit, _ = registration.register_matte(Image.fromarray(rgb),Image.fromarray(alpha))
        self.assertFalse(audit['applied'], audit)
        np.testing.assert_array_equal(np.asarray(result),alpha)


if __name__ == '__main__':
    unittest.main()
