"""Independent whole-RGBA coordinate sampling for the native fallback.

No morphology or color repair is performed. Reject collisions, clipped objects,
and topology loss rather than silently changing the selected subject.
"""
import importlib.util
from pathlib import Path
import cv2
import numpy as np
from scipy import ndimage
from PIL import Image

spec = importlib.util.spec_from_file_location("shared_native_sampler", Path(__file__).with_name("native-rgba-registration.py"))
registration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registration)


def topology(binary):
    components = cv2.connectedComponents(binary.astype(np.uint8), connectivity=8)[0]-1
    holes = ndimage.label(ndimage.binary_fill_holes(binary) & ~binary)[1]
    return components, holes


def sample_components(raw, transforms, mapping, expected_size, residual_transform=None, *,
                      allow_partial=False, required_region=None):
    scope = None
    if required_region is not None:
        scope = np.asarray(required_region, bool)
        if not allow_partial or scope.shape != (expected_size[1], expected_size[0]) or not scope.any():
            raise ValueError("NATIVE_COMPONENT_INVALID_SCOPE")
    values = np.asarray(raw.convert("RGBA"))
    count, labels = cv2.connectedComponents((values[..., 3] >= 128).astype(np.uint8), connectivity=8)
    if count <= 1 or count-1 != len(transforms):
        raise ValueError("NATIVE_COMPONENT_COUNT")
    coverage_count, coverage = cv2.connectedComponents((values[..., 3] > 0).astype(np.uint8), connectivity=8)
    anchored = set(np.unique(coverage[labels > 0]).tolist())
    residual = (coverage > 0) & ~np.isin(coverage, list(anchored))
    if residual.any() and residual_transform is None:
        raise ValueError("NATIVE_COMPONENT_UNANCHORED_ALPHA")
    nearest = ndimage.distance_transform_edt(labels == 0, return_distances=False, return_indices=True)
    owners = labels[tuple(nearest)]
    owners[residual] = 0
    width, height = expected_size
    result = np.zeros((height, width, 4), np.float64)
    occupied = np.zeros((height, width), bool)
    region = mapping["contentRegion"]
    active = []
    for index, transform in enumerate(transforms, 1):
        if transform is None:
            if not allow_partial:
                raise ValueError("NATIVE_COMPONENT_GEOMETRY")
            continue
        active.append(index)
        matrix = np.asarray(transform, np.float64)
        if matrix.shape != (2, 3) or not np.isfinite(matrix).all() or np.linalg.det(matrix[:, :2]) <= 0:
            raise ValueError("NATIVE_COMPONENT_GEOMETRY")
        component = values.copy()
        component[owners != index] = 0
        # Reject clipping of solid material; soft coverage uses the same crop
        # sampling as the existing renderer, without alpha thresholding.
        y, x = np.where(component[..., 3] >= 128)
        mapped = cv2.transform(np.stack((x, y), axis=1)[None].astype(np.float64), matrix)[0]
        if (mapped[:, 0].min() < region["x"]-.5 or mapped[:, 1].min() < region["y"]-.5
                or mapped[:, 0].max() > region["x"]+region["width"]-.5
                or mapped[:, 1].max() > region["y"]+region["height"]-.5):
            raise ValueError("NATIVE_COMPONENT_CLIPPED")
        sampled = np.asarray(registration.sample_aligned(Image.fromarray(component), matrix, mapping, expected_size))
        opaque = sampled[..., 3] >= 128
        if np.any(opaque & occupied):
            raise ValueError(f"NATIVE_COMPONENT_OVERLAP: opaque component {index}, pixels {np.count_nonzero(opaque & occupied)}")
        sampled_topology, original_topology = topology(opaque), topology(labels == index)
        if sampled_topology != original_topology:
            raise ValueError(f"NATIVE_COMPONENT_TOPOLOGY: component {index}, "
                             f"raw={original_topology}, sampled={sampled_topology}")
        occupied |= opaque
        alpha = sampled[..., 3:4].astype(np.float64)/255
        result[..., :3] += sampled[..., :3]*alpha
        result[..., 3:4] += sampled[..., 3:4]
    if residual.any():
        matrix = np.asarray(residual_transform, np.float64)
        if matrix.shape != (2, 3) or not np.isfinite(matrix).all() or np.linalg.det(matrix[:, :2]) <= 0:
            raise ValueError("NATIVE_COMPONENT_GEOMETRY")
        remaining = values.copy()
        remaining[~residual] = 0
        sampled = np.asarray(registration.sample_aligned(Image.fromarray(remaining), matrix, mapping, expected_size))
        result[..., :3] += sampled[..., :3]*(sampled[..., 3:4].astype(np.float64)/255)
        result[..., 3:4] += sampled[..., 3:4]
    # Separate pieces may touch after transformation without overlapping a pixel.
    sampled_topology = topology(result[..., 3] >= 128)
    original_topology = topology(np.isin(labels, active))
    if scope is not None and sampled_topology != original_topology:
        # A repair intermediate is never delivered outside the frozen scope.
        # Ignore only soft-coverage contacts wholly in that protected exterior.
        # Solid component topology/overlap has already been checked above.
        # This changes the validation probe only, not one delivered RGBA pixel.
        probe = result[..., 3] >= 128
        probe[~scope] = occupied[~scope]
        sampled_topology = topology(probe)
    if not active or sampled_topology != original_topology:
        raise ValueError(f"NATIVE_COMPONENT_TOPOLOGY: combined active={active}, "
                         f"raw={original_topology}, sampled={sampled_topology}")
    if np.any(result[..., 3] > 255):
        raise ValueError(f"NATIVE_COMPONENT_OVERLAP: accumulated coverage, pixels {np.count_nonzero(result[..., 3] > 255)}")
    alpha = result[..., 3:4]/255
    result[..., :3] = np.divide(result[..., :3], alpha, out=np.zeros_like(result[..., :3]), where=alpha > 0)
    return Image.fromarray(np.rint(np.clip(result, 0, 255)).astype(np.uint8))
