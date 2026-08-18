import importlib.metadata
import json
import os
import platform
import sys
from types import SimpleNamespace


original_arguments = list(getattr(sys, "orig_argv", sys.argv))[1:]
log_path = os.environ.get("FAKE_PYTHON_LOG")
if log_path:
    with open(log_path, "a", encoding="utf-8") as log_file:
        log_file.write(json.dumps({"command": sys.executable, "args": original_arguments}) + "\n")

fake_version = os.environ.get("FAKE_PYTHON_VERSION")
if fake_version:
    major, minor = (int(part) for part in fake_version.split(".", 1))
    sys.version_info = SimpleNamespace(major=major, minor=minor)

fake_cache_tag = os.environ.get("FAKE_PYTHON_CACHE_TAG")
if fake_cache_tag:
    try:
        sys.implementation.cache_tag = fake_cache_tag
    except (AttributeError, TypeError):
        pass

fake_platform = os.environ.get("FAKE_PYTHON_PLATFORM")
if fake_platform:
    sys.platform = fake_platform

fake_architecture = os.environ.get("FAKE_PYTHON_ARCH")
if fake_architecture:
    platform.machine = lambda: fake_architecture


class _Distribution:
    version = os.environ.get("FAKE_REMBG_VERSION", "2.0.69")


importlib.metadata.version = lambda _name: _Distribution.version
importlib.metadata.distribution = lambda _name: _Distribution()
