import os

os.environ.setdefault("NUMBA_DISABLE_JIT", "1")

from rembg import new_session


new_session("bria-rmbg")
print("BRIA RMBG 2.0 (bria-rmbg) model ready")
