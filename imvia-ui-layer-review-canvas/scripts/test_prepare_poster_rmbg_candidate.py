import importlib.util
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).with_name("prepare-poster-rmbg-candidate.py")
SPEC = importlib.util.spec_from_file_location("prepare_poster_rmbg_candidate", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PreparePosterRmbgCandidateTest(unittest.TestCase):
    def test_scales_native_alpha_to_full_canvas_and_writes_alpha_and_keyed_pngs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native-alpha.png"
            alpha_output = root / "full-alpha.png"
            keyed_output = root / "candidate.png"

            image = Image.new("RGBA", (6, 12), (30, 40, 50, 0))
            for y in range(2, 10):
                for x in range(2, 4):
                    image.putpixel((x, y), (210, 30, 20, 255))
            image.save(source)

            result = MODULE.prepare_candidate(
                source, alpha_output, keyed_output, (12, 24), "#00FF00"
            )

            with Image.open(alpha_output) as alpha:
                self.assertEqual(alpha.size, (12, 24))
                self.assertEqual(alpha.mode, "RGBA")
                self.assertEqual(alpha.getchannel("A").getextrema(), (0, 255))
            with Image.open(keyed_output) as keyed:
                self.assertEqual(keyed.size, (12, 24))
                self.assertEqual(keyed.mode, "RGB")
                self.assertEqual(keyed.getpixel((0, 0)), (0, 255, 0))
                self.assertNotEqual(keyed.getpixel((6, 12)), (0, 255, 0))

            self.assertEqual(result["native"], {"width": 6, "height": 12})
            self.assertEqual(result["output"], {"width": 12, "height": 24})
            self.assertTrue(result["real_alpha"])

    def test_rejects_opaque_rmbg_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "opaque.png"
            Image.new("RGBA", (6, 12), (30, 40, 50, 255)).save(source)
            with self.assertRaisesRegex(ValueError, "transparent pixels"):
                MODULE.prepare_candidate(
                    source, root / "full-alpha.png", root / "candidate.png", (12, 24), "#00FF00"
                )

    def test_rejects_large_aspect_ratio_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "wide.png"
            image = Image.new("RGBA", (12, 6), (30, 40, 50, 0))
            image.putpixel((6, 3), (210, 30, 20, 255))
            image.save(source)
            with self.assertRaisesRegex(ValueError, "aspect ratio"):
                MODULE.prepare_candidate(
                    source, root / "full-alpha.png", root / "candidate.png", (12, 24), "#00FF00"
                )


if __name__ == "__main__":
    unittest.main()
