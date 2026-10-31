"""Bounded topology correction from an executor's independent source inspection.

Color contrast locates an edge; it cannot decide whether it is a material seam
or a hole. Never infer that semantic decision from the proposed alpha itself.
"""
import numpy as np
from PIL import Image
from scipy import ndimage as nd


def fail(code):
    raise ValueError(code)


def hole_components(matte, transform=None):
    foreground = np.asarray(matte.convert('L')) >= 128
    holes = nd.binary_fill_holes(foreground) & ~foreground
    labels, count = nd.label(holes)
    coverage_areas = {}
    if transform is not None:
        import cv2
        matrix = np.asarray(transform, dtype=np.float32)
        transported = np.zeros_like(labels)
        strongest = np.zeros(labels.shape, np.uint8)
        # Labels are identities, not colors. Nearest-neighbour sampling can
        # erase a one-pixel counter at a half-pixel shift. Carry each counter's
        # coverage through the SAME linear transform used by the alpha image.
        # Work in local bounding boxes, not one full-size allocation per hole.
        for index, box in enumerate(nd.find_objects(labels), 1):
            sy, sx = box
            corners = np.array([[sx.start, sy.start, 1], [sx.stop, sy.start, 1],
                                [sx.start, sy.stop, 1], [sx.stop, sy.stop, 1]]) @ matrix.T
            x0, y0 = np.maximum(0, np.floor(corners.min(axis=0))-2).astype(int)
            x1, y1 = np.minimum(matte.size, np.ceil(corners.max(axis=0))+2).astype(int)
            if x0 >= x1 or y0 >= y1:
                fail('SEMANTIC_COUNTER_LOST')
            local_matrix = matrix.copy()
            local_matrix[:, 2] += matrix[:, :2] @ [sx.start, sy.start] - [x0, y0]
            coverage = cv2.warpAffine(np.uint8(labels[box] == index)*255,
                                     local_matrix, (x1-x0, y1-y0), flags=cv2.INTER_LINEAR)
            coverage_areas[index] = float(coverage.sum())/255
            roi = np.s_[y0:y1, x0:x1]
            owner = coverage > strongest[roi]
            transported[roi][owner] = index
            strongest[roi][owner] = coverage[owner]
        labels = transported
        if any(not np.any(labels == index) for index in range(1, count+1)):
            fail('SEMANTIC_COUNTER_LOST')
    items = []
    for index, box in enumerate(nd.find_objects(labels), 1):
        local = labels[box] == index
        distance = nd.distance_transform_edt(np.pad(local, 1))[1:-1, 1:-1]
        y, x = np.unravel_index(distance.argmax(), distance.shape)
        items.append({'id': index, 'area': int(local.sum()),
                      'coverageArea': coverage_areas.get(index, float(local.sum())),
                      'bounds': {'x': box[1].start, 'y': box[0].start,
                                 'width': box[1].stop-box[1].start, 'height': box[0].stop-box[0].start},
                      'point': [int(x+box[1].start), int(y+box[0].start)]})
    return labels, items


def material_notch_components(matte):
    """Enumerate small exterior-connected pockets, without deciding material.

    A grille accidentally removed by the proposal is often open to the outside,
    so it can never be returned by hole_components. This fixed four-source-pixel
    closing only enumerates pockets; it does NOT apply them. The executor must
    inspect an entire pocket against the source before declaring it opaque.
    Enclosed counters are excluded, and single-pixel closing noise is omitted.
    """
    import cv2
    foreground = np.asarray(matte.convert('L')) >= 128
    closed = cv2.morphologyEx(foreground.astype(np.uint8), cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    pockets, _ = nd.label(closed & ~nd.binary_fill_holes(foreground))
    labels = np.zeros_like(pockets)
    items = []
    for index, box in enumerate(nd.find_objects(pockets), 1):
        region = pockets[box] == index
        area = int(region.sum())
        if area < 8:
            continue
        identity = len(items)+1
        labels[box][region] = identity
        distance = nd.distance_transform_edt(np.pad(region, 1))[1:-1,1:-1]
        y,x = np.unravel_index(distance.argmax(), distance.shape)
        items.append({'id': identity, 'area': area,
                      'bounds': {'x': box[1].start, 'y': box[0].start,
                                 'width': box[1].stop-box[1].start, 'height': box[0].stop-box[0].start},
                      'point': [int(x+box[1].start), int(y+box[0].start)]})
    return labels, items


def prepare_topology(source, matte, guide, scope=None, transform=None):
    if (not isinstance(guide, dict) or guide.get('version') != 1
            or guide.get('coordinateSpace') != 'selected_region_pixels'
            or guide.get('profile') not in ('flat_graphic', 'material_composite', 'organic_subject')):
        fail('SEMANTIC_TOPOLOGY_INVALID')
    labels, holes = hole_components(matte, transform)
    decisions = guide.get('holes')
    if (not isinstance(decisions, list) or len(decisions) != len(holes)
            or any(not isinstance(item, dict) or type(item.get('id')) is not int for item in decisions)
            or sorted(item['id'] for item in decisions) != list(range(1, len(holes)+1))):
        fail('SEMANTIC_HOLE_COVERAGE_MISMATCH')
    objects = guide.get('objects')
    if not isinstance(objects, list) or not objects:
        fail('SEMANTIC_OBJECTS_REQUIRED')
    for item in objects:
        if (not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name'].strip()
                or not isinstance(item.get('point'), list) or len(item['point']) != 2
                or any(type(value) is not int for value in item['point'])
                or not 0 <= item['point'][0] < matte.width or not 0 <= item['point'][1] < matte.height):
            fail('SEMANTIC_OBJECT_POINT_INVALID')
    values = np.asarray(matte.convert('L')).copy()
    if transform is not None:
        import cv2
        matrix = np.asarray(transform, dtype=np.float32)
        # Decisions bind raw hole IDs. Carry those labels with the mask rather
        # than renumbering holes and accidentally applying a decision elsewhere.
        values = cv2.warpAffine(values, matrix, matte.size, flags=cv2.INTER_LINEAR)
        # Object points, source transparency and the user scope are SOURCE
        # coordinates. They must never follow the generated mask's transform.
    allowed = np.ones_like(values, bool) if scope is None else np.asarray(scope) == 255
    native_alpha = np.asarray(source.convert('RGBA'))[..., 3]
    hull = nd.binary_fill_holes(values >= 128)
    outer_distance = nd.distance_transform_edt(hull)
    restored = np.zeros_like(hull)
    notch_decisions = guide.get('materialNotches', [])
    if (not isinstance(notch_decisions, list)
            or any(not isinstance(item, dict) or type(item.get('id')) is not int
                   or not isinstance(item.get('reason'), str) or not item['reason'].strip()
                   for item in notch_decisions)
            or len({item['id'] for item in notch_decisions}) != len(notch_decisions)
            or (notch_decisions and guide['profile'] != 'material_composite')):
        fail('SEMANTIC_NOTCH_DECISION_INVALID')
    if notch_decisions:
        notch_labels, notches = material_notch_components(Image.fromarray(values))
        if any(not 1 <= item['id'] <= len(notches) for item in notch_decisions):
            fail('SEMANTIC_NOTCH_ID_INVALID')
        for item in notch_decisions:
            region = notch_labels == item['id']
            if np.any(region & ~allowed):
                fail('SEMANTIC_REPAIR_OUTSIDE_SELECTION')
            if np.any(region & (native_alpha < 255)):
                fail('SEMANTIC_REPAIR_SOURCE_TRANSPARENCY')
            restored |= region
    for item in decisions:
        if item.get('treatment') not in ('preserve', 'fill_material') or not isinstance(item.get('reason'), str) or not item['reason'].strip():
            fail('SEMANTIC_HOLE_DECISION_INVALID')
        if item['treatment'] == 'preserve':
            continue
        region = labels == item['id']
        # Restore only enclosed interior voids, never exterior notches or whole
        # silhouettes. Include their AA fringe, but not another nearby counter.
        region = nd.binary_dilation(region) & hull & ((labels == 0) | (labels == item['id']))
        if np.any(region & ~allowed):
            fail('SEMANTIC_REPAIR_OUTSIDE_SELECTION')
        if np.any(region & (native_alpha < 255)):
            fail('SEMANTIC_REPAIR_SOURCE_TRANSPARENCY')
        if np.any(region & (outer_distance <= 1)):
            fail('SEMANTIC_REPAIR_NEAR_OUTER_CONTOUR')
        restored |= region
    if restored.sum() > max(1, np.count_nonzero(values >= 128)) * .25:
        fail('SEMANTIC_REPAIR_TOO_LARGE')
    values[restored] = 255
    # White-on-black semantic mattes describe solid material, but generated
    # white interiors can contain 247..254 quantization/noise. That is not
    # intentional translucency. Normalize only the deep, near-white core of a
    # source-inspected material assembly, BEFORE any local deformation. Keep
    # a three-pixel band around every edge/counter/gray region untouched.
    # Native transparency, user exclusions and organic/soft subjects opt out.
    normalized = np.zeros_like(restored)
    if guide['profile'] == 'material_composite':
        near_white = (values >= 247) & allowed & (native_alpha == 255)
        normalized = near_white & (values < 255) & (nd.distance_transform_edt(near_white) > 3)
        values[normalized] = 255
    audit = {'version': 1, 'profile': guide['profile'], 'status': 'pending', 'holeCount': len(holes),
             'counterCoverageAreas': {str(item['id']): item['coverageArea'] for item in holes},
             'restoredHoleIds': [item['id'] for item in decisions if item['treatment'] == 'fill_material'],
             'restoredNotchIds': [item['id'] for item in notch_decisions],
             'preservedHoleIds': [item['id'] for item in decisions if item['treatment'] == 'preserve'],
             'restoredPixels': int(restored.sum()), 'objectCount': len(objects),
             'normalizedOpaqueInteriorPixels': int(normalized.sum())}
    return Image.fromarray(values), audit, (labels, restored, objects)


def transport_counter_evidence(audit, evidence, inverse_map):
    """Carry counter identities with the SAME inverse map as the alpha.

    Source object anchors and source-inspected material remain fixed. Only
    generated mask hole identities follow the geometric correction.
    """
    import cv2
    labels, restored, objects = evidence
    map_x, map_y = inverse_map
    if map_x.shape != labels.shape or map_y.shape != labels.shape:
        fail('SEMANTIC_TRANSFORM_DIMENSIONS_MISMATCH')
    y, x = np.indices(labels.shape)
    radius = int(np.ceil(max(np.max(np.abs(map_x-x)), np.max(np.abs(map_y-y)))))+3
    transported = np.zeros_like(labels)
    strongest = np.zeros(labels.shape, np.uint8)
    updated = {**audit, 'counterCoverageAreas': dict(audit.get('counterCoverageAreas', {}))}
    h, w = labels.shape
    for index, box in enumerate(nd.find_objects(labels), 1):
        if box is None:
            fail('SEMANTIC_COUNTER_LOST')
        sy, sx = box
        region = labels[box] == index
        y0, y1 = max(0, sy.start-radius), min(h, sy.stop+radius)
        x0, x1 = max(0, sx.start-radius), min(w, sx.stop+radius)
        roi = np.s_[y0:y1, x0:x1]
        coverage = cv2.remap(region.astype(np.uint8)*255,
            (map_x[roi]-sx.start).astype(np.float32), (map_y[roi]-sy.start).astype(np.float32),
            cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        if not coverage.any():
            fail('SEMANTIC_COUNTER_LOST')
        prior = audit.get('counterCoverageAreas', {}).get(str(index), float(region.sum()))
        updated['counterCoverageAreas'][str(index)] = float(coverage.sum())/255*prior/region.sum()
        owner = coverage > strongest[roi]
        transported[roi][owner] = index
        strongest[roi][owner] = coverage[owner]
    if set(np.unique(transported)) != set(np.unique(labels)):
        fail('SEMANTIC_COUNTER_LOST')
    updated['counterTransform'] = 'shared_source_deformation'
    return updated, (transported, restored, objects)


def verify_topology(alpha, audit, evidence):
    labels, restored, objects = evidence
    values = np.asarray(alpha)
    if np.any(values[restored] < 128):
        fail('SEMANTIC_MATERIAL_LOST')
    for item in objects:
        x, y = item['point']
        if values[y, x] < 128:
            fail('SEMANTIC_OBJECT_MISSING')
    final_labels, final_holes = hole_components(Image.fromarray(values.astype(np.uint8)))
    used_counters = set()
    soft_labels = None
    used_soft_counters = set()
    occupied = np.zeros_like(values, bool)
    for index in audit['preservedHoleIds']:
        original = labels == index
        expected_area = audit.get('counterCoverageAreas', {}).get(str(index), int(original.sum()))
        overlap = np.bincount(final_labels[original])
        overlap[0] = 0
        match = int(overlap.argmax())
        # Keep the established enclosed-component test authoritative wherever
        # the counter is still represented by binary foreground/background.
        # Its AA fringe need not equal the area of its thresholded core.
        if (match and match not in used_counters
                and final_holes[match-1]['area'] >= max(1, expected_area*.5)):
            region = final_labels == match
            if np.any(region & occupied):
                fail('SEMANTIC_COUNTER_LOST')
            occupied |= region
            used_counters.add(match)
            continue
        if match:
            fail('SEMANTIC_COUNTER_LOST')
        if expected_area <= 4:
            # Subpixel holes need not contain a <128 pixel. Verify enclosed
            # transparency coverage, not a binary count. This does NOT permit
            # a large counter to collapse, open to the exterior or be replaced
            # by a low-opacity plate: those have no matching enclosed region.
            if soft_labels is None:
                opaque = values >= 247
                soft_labels, _ = nd.label(nd.binary_fill_holes(opaque) & ~opaque)
            overlap = np.bincount(soft_labels[original])
            overlap[0] = 0
            match = int(overlap.argmax())
            region = soft_labels == match if match else np.zeros_like(original)
            coverage = float(np.sum(255-values[region].astype(float)))/255
            if (not match or match in used_soft_counters
                    or np.any(region & occupied)
                    or not .75*expected_area <= coverage <= 1.25*expected_area+.02
                    or region.sum() > max(4, expected_area*8)):
                fail('SEMANTIC_COUNTER_LOST')
            used_soft_counters.add(match)
            occupied |= region
            continue
        # A single protected pixel is not a preserved counter. Match a distinct
        # enclosed component and reject severe area loss or merged counters.
        fail('SEMANTIC_COUNTER_LOST')
    audit['status'] = 'passed'
