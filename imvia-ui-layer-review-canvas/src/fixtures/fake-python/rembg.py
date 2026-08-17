import os


if os.environ.get("FAKE_REMBG_FAIL") == "1":
    raise ImportError("simulated rembg import failure")


def new_session(_model):
    return object()


def remove(image, *args, **kwargs):
    return image
