import re
from pathlib import Path


WINDOWS_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
WINDOWS_RESERVED = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.IGNORECASE)


def safe_layer_id(value):
    layer_id = "" if value is None else str(value)
    if (
        not layer_id
        or layer_id != layer_id.strip()
        or ".." in layer_id
        or WINDOWS_INVALID.search(layer_id)
        or WINDOWS_DRIVE.match(layer_id)
        or WINDOWS_RESERVED.match(layer_id)
        or layer_id.endswith((".", " "))
    ):
        raise ValueError(f"unsafe layer id: {layer_id!r}")
    return layer_id


def contained_child(root, filename):
    resolved_root = Path(root).resolve()
    candidate = (resolved_root / filename).resolve()
    try:
        candidate.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError("output path escapes its allowed directory") from error
    if candidate.parent != resolved_root:
        raise ValueError("output path must be a direct child of its allowed directory")
    return candidate
