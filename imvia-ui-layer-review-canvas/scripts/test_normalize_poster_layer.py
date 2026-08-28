import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


SCRIPT_PATH = Path(__file__).with_name('normalize-poster-layer.py')
SPEC = importlib.util.spec_from_file_location('normalize_poster_layer', SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NormalizePosterLayerTest(unittest.TestCase):
    def test_uniformly_scales_an_opaque_keyed_png_to_the_source_canvas(self):
        image = Image.new('RGB', (4, 2), '#00FF00')
        image.putpixel((2, 1), (255, 0, 0))

        normalized = MODULE.normalize_candidate(image, (8, 4), '#00FF00')

        self.assertEqual(normalized.mode, 'RGB')
        self.assertEqual(normalized.size, (8, 4))
        self.assertEqual(normalized.getpixel((0, 0)), (0, 255, 0))

    def test_fully_opaque_rgba_is_allowed_but_mixed_alpha_is_rejected(self):
        opaque = Image.new('RGBA', (4, 2), (0, 255, 0, 255))
        self.assertEqual(
            MODULE.normalize_candidate(opaque, (8, 4), '#00FF00').mode,
            'RGB',
        )

        mixed = opaque.copy()
        mixed.putpixel((2, 1), (255, 0, 0, 128))
        with self.assertRaisesRegex(MODULE.ValidationError, 'CANVAS_OR_GREEN_FIELD_INVALID'):
            MODULE.normalize_candidate(mixed, (8, 4), '#00FF00')

    def test_rejects_aspect_ratio_changes_as_registration_uncertain(self):
        image = Image.new('RGB', (4, 3), '#00FF00')
        with self.assertRaisesRegex(MODULE.ValidationError, 'REGISTRATION_UNCERTAIN'):
            MODULE.normalize_candidate(image, (8, 4), '#00FF00')

    def test_rejects_a_contaminated_key_field(self):
        image = Image.new('RGB', (4, 2), '#00FF00')
        image.putpixel((0, 0), (0, 254, 0))
        with self.assertRaisesRegex(MODULE.ValidationError, 'KEY_UNUSABLE'):
            MODULE.normalize_candidate(image, (8, 4), '#00FF00')

    def test_cli_rejects_fill_colors_that_conflict_with_compositing_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary, 'candidate.png')
            output = Path(temporary, 'normalized.png')
            Image.new('RGB', (4, 2), '#00FF00').save(source)
            result = subprocess.run([
                sys.executable, str(SCRIPT_PATH), '--input', str(source), '--output', str(output),
                '--source-width', '8', '--source-height', '4', '--fill-color', '#00FF00',
                '--compositing-mode', 'Screen',
            ], capture_output=True, text=True, check=False)

            self.assertFalse(output.exists())

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CANVAS_OR_GREEN_FIELD_INVALID', result.stderr)

    def test_cli_rejects_a_jpeg_renamed_with_a_png_extension(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary, 'renamed.png')
            output = Path(temporary, 'normalized.png')
            Image.new('RGB', (4, 2), '#00FF00').save(source, format='JPEG')
            result = subprocess.run([
                sys.executable, str(SCRIPT_PATH), '--input', str(source), '--output', str(output),
                '--source-width', '8', '--source-height', '4', '--fill-color', '#00FF00',
                '--compositing-mode', 'Normal',
            ], capture_output=True, text=True, check=False)

            self.assertFalse(output.exists())

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CANVAS_OR_GREEN_FIELD_INVALID', result.stderr)
        self.assertIn('PNG', result.stderr)


if __name__ == '__main__':
    unittest.main()
