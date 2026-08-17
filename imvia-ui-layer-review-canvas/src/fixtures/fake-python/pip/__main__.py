import os
import sys
import time


arguments = sys.argv[1:]
if "install" in arguments and os.environ.get("FAKE_PIP_FAIL") == "1":
    sys.stderr.write("simulated pip failure")
    raise SystemExit(7)

delay_ms = int(os.environ.get("FAKE_PIP_DELAY_MS", "0"))
if delay_ms > 0:
    time.sleep(delay_ms / 1000)
