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

    def test_run_rmbg_uses_fixed_model_call_and_validates_real_alpha(self):
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
                return data

            result = MODULE.run_rmbg(
                input_path,
                output_path,
                "isnet-general-use",
                (2, 2),
                session_factory=session_factory,
                remove_fn=remove_fn,
            )
            self.assertTrue(result["real_alpha"])
            self.assertEqual(calls, [("session", "isnet-general-use"), ("remove", "session", False)])
            with Image.open(output_path) as image:
                self.assertEqual(image.size, (2, 2))

    def test_run_rmbg_rejects_wrong_input_before_model_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "input.png"
            input_path.write_bytes(self.png_bytes((3, 2)))
            with self.assertRaisesRegex(ValueError, "already be the final split size"):
                MODULE.run_rmbg(input_path, root / "out.png", "isnet-general-use", (2, 2), session_factory=lambda _: self.fail("must not create session"))


if __name__ == "__main__":
    unittest.main()
