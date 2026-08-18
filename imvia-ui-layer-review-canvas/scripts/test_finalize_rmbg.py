import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image


MODULE_PATH = Path(__file__).with_name("finalize-rmbg.py")
SPEC = importlib.util.spec_from_file_location("finalize_rmbg", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FinalizeRmbgTests(unittest.TestCase):
    def png_bytes(self, size=(2, 2)):
        stream = io.BytesIO()
        image = Image.new("RGBA", size, (1, 2, 3, 255))
        image.putpixel((0, 0), (1, 2, 3, 0))
        image.save(stream, format="PNG")
        return stream.getvalue()

    def test_run_rmbg_uses_bria_rmbg_2_model_call_and_validates_real_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.png"
            output_path = root / "out.png"
            input_path.write_bytes(self.png_bytes())
            calls = []

            def session_factory(model):
                calls.append(("session", model))
                return "session"

            def remove_fn(data, *, session, alpha_matting):
                calls.append(("remove", session, alpha_matting))
                with Image.open(io.BytesIO(data)) as model_input:
                    model_output = model_input.convert("RGBA")
                alpha = Image.new("L", model_output.size, 255)
                alpha.paste(0, (0, 0, model_output.width * 3 // 4, model_output.height))
                model_output.putalpha(alpha)
                stream = io.BytesIO()
                model_output.save(stream, format="PNG")
                return stream.getvalue()

            result = MODULE.run_rmbg(
                input_path,
                output_path,
                "bria-rmbg",
                (2, 2),
                session_factory=session_factory,
                remove_fn=remove_fn,
            )
            self.assertTrue(result["real_alpha"])
            self.assertEqual(calls, [("session", "bria-rmbg"), ("remove", "session", False)])
            with Image.open(output_path) as image:
                self.assertEqual(image.size, (2, 2))

    def test_run_rmbg_rejects_wrong_input_before_model_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.png"
            input_path.write_bytes(self.png_bytes((3, 2)))
            with self.assertRaisesRegex(ValueError, "already be the final split size"):
                MODULE.run_rmbg(input_path, root / "out.png", "bria-rmbg", (2, 2), session_factory=lambda _: self.fail("must not create session"))

    def test_run_rmbg_preserves_source_rgb_and_only_accepts_model_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.png"
            output_path = root / "out.png"
            source = Image.new("RGBA", (2, 2), (240, 80, 20, 255))
            source.putpixel((0, 0), (20, 40, 60, 255))
            source.save(input_path, format="PNG")

            def remove_fn(data, **_kwargs):
                with Image.open(io.BytesIO(data)) as model_input:
                    model_output = model_input.convert("RGBA")
                alpha = Image.new("L", model_output.size, 255)
                alpha.paste(0, (0, 0, model_output.width * 3 // 4, model_output.height))
                model_output.putalpha(alpha)
                stream = io.BytesIO()
                model_output.save(stream, format="PNG")
                return stream.getvalue()

            result = MODULE.run_rmbg(
                input_path,
                output_path,
                "bria-rmbg",
                (2, 2),
                session_factory=lambda _: "session",
                remove_fn=remove_fn,
            )

            self.assertTrue(result["source_rgb_locked"])
            with Image.open(output_path) as image:
                self.assertEqual(image.convert("RGBA").getpixel((0, 0)), (20, 40, 60, 0))
                visible = image.convert("RGBA").getpixel((1, 1))
                self.assertEqual(visible[:3], (240, 80, 20))
                self.assertGreater(visible[3], 0)

    def test_prepare_letterboxed_input_preserves_wide_aspect_ratio(self):
        source = Image.new("RGB", (177, 87), (240, 80, 20))

        canvas, mapping = MODULE.prepare_letterboxed_input(source, (1024, 1024))

        self.assertEqual(canvas.size, (1024, 1024))
        self.assertEqual(mapping["canvas"], {"width": 1024, "height": 1024})
        self.assertEqual(mapping["content_region"], {
            "x": 0,
            "y": 260,
            "width": 1024,
            "height": 503,
        })
        self.assertEqual(mapping["source"], {"width": 177, "height": 87})

    def test_run_rmbg_sends_letterboxed_canvas_to_model_and_maps_alpha_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.png"
            output_path = root / "out.png"
            source = Image.new("RGBA", (177, 87), (240, 80, 20, 255))
            source.save(input_path, format="PNG")
            received = []

            def remove_fn(data, *, session, alpha_matting):
                with Image.open(io.BytesIO(data)) as model_input:
                    received.append((model_input.size, session, alpha_matting))
                model_output = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
                alpha = Image.new("L", (1024, 1024), 0)
                alpha.paste(255, (0, 260, 1024, 763))
                alpha.paste(0, (0, 260, 96, 356))
                model_output.putalpha(alpha)
                stream = io.BytesIO()
                model_output.save(stream, format="PNG")
                return stream.getvalue()

            result = MODULE.run_rmbg(
                input_path,
                output_path,
                "bria-rmbg",
                (177, 87),
                session_factory=lambda _: "session",
                remove_fn=remove_fn,
            )

            self.assertEqual(received, [((1024, 1024), "session", False)])
            self.assertEqual(result["preprocess"], "letterbox")
            with Image.open(output_path) as image:
                rgba = image.convert("RGBA")
                self.assertEqual(rgba.size, (177, 87))
                self.assertEqual(rgba.getpixel((176, 86))[:3], (240, 80, 20))
                self.assertEqual(rgba.getchannel("A").getextrema(), (0, 255))


if __name__ == "__main__":
    unittest.main()
