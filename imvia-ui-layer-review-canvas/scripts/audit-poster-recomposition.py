import argparse
import hashlib
import io
import json
import os
import stat
import uuid
from pathlib import Path

from PIL import Image, ImageChops, UnidentifiedImageError


ALLOWED_KEYS = {
    'normal': '#00FF00',
    'screen': '#000000',
    'add': '#000000',
    'screen/add': '#000000',
}
EXACT_RELEASE_CHECKS = {
    'source_comparison', 'locked_anchors', 'repair_envelope',
    'canvas_dimensions', 'key_field',
}
CHANNEL_TOLERANCE = 8
MIN_SOURCE_SIMILARITY = 0.995
MAX_MEAN_ABSOLUTE_ERROR = 1.0
MIN_COVERAGE_RATIO = 0.999


def _arguments(argv=None):
    parser = argparse.ArgumentParser(description='Audit deterministic poster layer recomposition.')
    parser.add_argument('--job-directory', required=True)
    return parser.parse_args(argv)


def _pixel_data(image):
    get_flattened_data = getattr(image, 'get_flattened_data', None)
    return get_flattened_data() if get_flattened_data else image.getdata()


def _read_json(path):
    with path.open('r', encoding='utf-8') as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f'{path.name} must contain an object')
    return value


def _inside(root, target):
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def _append_failure(failures, code):
    if code not in failures:
        failures.append(code)


def _hex_color(value):
    return tuple(int(value[offset:offset + 2], 16) for offset in (1, 3, 5))


def _key_mask(image, fill):
    pixels = image.load()
    mask = Image.new('L', image.size, 0)
    mask_pixels = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            if pixels[x, y] != fill:
                mask_pixels[x, y] = 255
    return mask


def _reject_link(details):
    return (stat.S_ISLNK(details.st_mode)
            or bool(getattr(details, 'st_file_attributes', 0) & 0x400))


class _WindowsDirectory:
    """Pin a real Windows directory without granting rename/delete sharing."""
    def __init__(self, path):
        import ctypes
        from ctypes import wintypes
        self.path = Path(path)
        self.identity = None
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        before = os.lstat(self.path)
        if _reject_link(before) or not stat.S_ISDIR(before.st_mode):
            raise OSError('directory is not a real directory')
        # FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
        self.handle = kernel.CreateFileW(str(self.path), 0, 3, None, 3, 0x02200000, None)
        if self.handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        self.kernel = kernel
        try:
            self.identity = (before.st_dev, before.st_ino)
            self.validate()
        except BaseException:
            self.close()
            raise

    def validate(self):
        details = os.lstat(self.path)
        if (_reject_link(details) or not stat.S_ISDIR(details.st_mode)
                or (details.st_dev, details.st_ino) != self.identity):
            raise OSError('pinned directory changed')

    def close(self):
        self.kernel.CloseHandle(self.handle)


def _open_directory(path):
    if os.name == 'nt':
        return _WindowsDirectory(path)
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    return os.open(path, flags)


def _close_directory(descriptor):
    if isinstance(descriptor, _WindowsDirectory):
        descriptor.close()
    else:
        os.close(descriptor)


def _read_pinned_regular(path):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    before = os.lstat(path)
    if _reject_link(before):
        raise OSError('not a regular non-link file')
    descriptor = os.open(path, flags)
    try:
        details = os.fstat(descriptor)
        if (details.st_dev, details.st_ino) != (before.st_dev, before.st_ino):
            raise OSError('file changed while opening')
        if not stat.S_ISREG(details.st_mode):
            raise OSError('not a regular file')
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b''.join(chunks)
    finally:
        os.close(descriptor)


def _read_pinned_regular_at(directory_fd, basename):
    if not isinstance(basename, str) or not basename or basename in ('.', '..') or '/' in basename or '\\' in basename:
        raise OSError('invalid file basename')
    if isinstance(directory_fd, _WindowsDirectory):
        directory_fd.validate()
        payload = _read_pinned_regular(directory_fd.path / basename)
        directory_fd.validate()
        return payload
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    descriptor = os.open(basename, flags, dir_fd=directory_fd)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            raise OSError('not a regular file')
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b''.join(chunks)
    finally:
        os.close(descriptor)


def _decode_rgb_png(payload):
    with Image.open(io.BytesIO(payload)) as opened:
        if opened.format != 'PNG':
            raise UnidentifiedImageError('not PNG')
        opened.load()
        original_mode = opened.mode
        return opened.convert('RGB'), original_mode


def _accepted_candidate(manifest, state, planned, plan_version):
    candidate_id = state.get('accepted_candidate_id')
    if not isinstance(candidate_id, str) or not candidate_id:
        return None
    candidates = manifest.get('candidates')
    if not isinstance(candidates, list):
        return None
    matches = [entry for entry in candidates if isinstance(entry, dict)
               and entry.get('candidate_id') == candidate_id]
    if len(matches) != 1:
        return None
    candidate = matches[0]
    digest = candidate.get('candidate_sha256')
    inspection = state.get('visual_inspection')
    gate = candidate.get('release_gate')
    checks = gate.get('checks') if isinstance(gate, dict) else None
    if not (
        candidate.get('layer_index') == planned.get('layer_index')
        and candidate.get('plan_version') == plan_version
        and candidate.get('status') == 'NEEDS_USER_REVIEW'
        and candidate.get('accepted') is True
        and candidate.get('failure_codes') == []
        and isinstance(digest, str) and len(digest) == 64
        and all(character in '0123456789abcdef' for character in digest)
        and candidate.get('path') == state.get('candidate_output')
        and candidate.get('candidate_number') == state.get('generation_count')
        and candidate.get('accepted_source_output') == state.get('source_output')
        and candidate.get('accepted_source_sha256') == state.get('source_sha256')
        and isinstance(inspection, dict)
        and inspection.get('performed') is True
        and inspection.get('candidate_id') == candidate_id
        and inspection.get('plan_version') == plan_version
        and inspection.get('candidate_sha256') == digest
        and inspection.get('verdict') == 'NEEDS_USER_REVIEW'
        and inspection.get('failure_codes') == []
        and isinstance(gate, dict)
        and gate.get('verdict') == 'NEEDS_USER_REVIEW'
        and gate.get('failureCodes') == []
        and gate.get('candidateId') == candidate_id
        and gate.get('planVersion') == plan_version
        and gate.get('candidateSha256') == digest
        and isinstance(checks, dict)
        and set(checks) == EXACT_RELEASE_CHECKS
        and all(checks.values())
    ):
        return None
    return candidate


def _declared_reference(values, other_index, other_name):
    if not isinstance(values, list):
        return False
    for value in values:
        if value == other_index or value == str(other_index) or value == other_name:
            return True
        if isinstance(value, dict) and (value.get('layer_index') == other_index
                                        or value.get('layer_name') == other_name):
            return True
    return False


def _declares_occlusion(front, back):
    return (_declared_reference(front.get('occludes'), back.get('layer_index'), back.get('layer_name'))
            or _declared_reference(back.get('occluded_by'), front.get('layer_index'), front.get('layer_name')))


def _secure_audit_directory(job, failures):
    audit_path = job / 'audit'
    try:
        if os.path.lexists(audit_path):
            details = os.lstat(audit_path)
            if _reject_link(details) or not stat.S_ISDIR(details.st_mode):
                raise OSError('audit path is not a real directory')
        else:
            os.mkdir(audit_path, 0o700)
        physical = audit_path.resolve(strict=True)
        if physical.parent != job or not _inside(job, physical):
            raise OSError('audit directory escaped job')
        descriptor = _open_directory(audit_path)
        details = os.lstat(audit_path) if isinstance(descriptor, _WindowsDirectory) else os.fstat(descriptor)
        if not stat.S_ISDIR(details.st_mode):
            _close_directory(descriptor)
            raise OSError('audit path changed type')
        return descriptor
    except OSError:
        _append_failure(failures, 'AUDIT_DIRECTORY_UNSAFE')
        return None


def _unlink_preview(audit_fd):
    if audit_fd is None:
        return
    try:
        if isinstance(audit_fd, _WindowsDirectory):
            audit_fd.validate()
            (audit_fd.path / 'recomposition-preview.png').unlink()
        else:
            os.unlink('recomposition-preview.png', dir_fd=audit_fd)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _write_preview(audit_fd, composite):
    temporary = f'.recomposition-preview.{uuid.uuid4().hex}.tmp.png'
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    windows = isinstance(audit_fd, _WindowsDirectory)
    if windows:
        audit_fd.validate()
    descriptor = (os.open(audit_fd.path / temporary, flags | getattr(os, 'O_BINARY', 0), 0o600)
                  if windows else os.open(temporary, flags, 0o600, dir_fd=audit_fd))
    try:
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            composite.save(stream, format='PNG')
            stream.flush()
            os.fsync(descriptor)
        if windows:
            # CRT file descriptors do not grant delete sharing; close after fsync
            # before the same-directory atomic replace. The directory stays pinned.
            os.close(descriptor)
            descriptor = None
            audit_fd.validate()
            os.replace(audit_fd.path / temporary, audit_fd.path / 'recomposition-preview.png')
        else:
            os.replace(temporary, 'recomposition-preview.png', src_dir_fd=audit_fd, dst_dir_fd=audit_fd)
            os.fsync(audit_fd)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            if windows:
                audit_fd.validate()
                (audit_fd.path / temporary).unlink()
            else:
                os.unlink(temporary, dir_fd=audit_fd)
        except FileNotFoundError:
            pass


def _composite_layer(composite, image, mask, mode):
    if mode == 'normal':
        composite.paste(image, (0, 0), mask)
        return composite
    blank = Image.new('RGB', image.size, (0, 0, 0))
    blank.paste(image, (0, 0), mask)
    if mode == 'add':
        return ImageChops.add(composite, blank)
    return ImageChops.screen(composite, blank)


def audit_job(job_directory, hooks=None):
    hooks = hooks or {}
    if not isinstance(hooks, dict):
        raise TypeError('hooks must be a dictionary')
    job = Path(job_directory).resolve()
    layers_root = job / 'layers'
    candidates_root = job / 'candidates'
    preview_path = job / 'audit' / 'recomposition-preview.png'
    failures = []
    conflicts = set()
    accepted_layers = []
    opened_layers = {}
    source_image = None
    source_digest = None
    composite = None
    candidates_fd = None

    audit_fd = _secure_audit_directory(job, failures)
    try:
        try:
            layers_details = os.lstat(layers_root)
            if _reject_link(layers_details) or not stat.S_ISDIR(layers_details.st_mode):
                raise OSError('layers root is not a real directory')
            if layers_root.resolve(strict=True).parent != job:
                raise OSError('layers root escaped job')
        except OSError:
            _append_failure(failures, 'MANIFEST_INCONSISTENCY')
        try:
            candidates_details = os.lstat(candidates_root)
            if _reject_link(candidates_details) or not stat.S_ISDIR(candidates_details.st_mode):
                raise OSError('candidates root is not a real directory')
            physical_candidates = candidates_root.resolve(strict=True)
            if physical_candidates.parent != job:
                raise OSError('candidates root escaped job')
            candidates_fd = _open_directory(candidates_root)
            pinned_details = os.lstat(candidates_root) if isinstance(candidates_fd, _WindowsDirectory) else os.fstat(candidates_fd)
            current_details = os.lstat(candidates_root)
            if (not stat.S_ISDIR(pinned_details.st_mode)
                    or pinned_details.st_dev != current_details.st_dev
                    or pinned_details.st_ino != current_details.st_ino):
                raise OSError('candidates root changed while opening')
            callback = hooks.get('after_candidates_directory_opened')
            if callback is not None:
                if not callable(callback):
                    raise TypeError('after_candidates_directory_opened hook must be callable')
                callback(candidates_fd)
        except OSError:
            if candidates_fd is not None:
                _close_directory(candidates_fd)
                candidates_fd = None
            _append_failure(failures, 'MANIFEST_INCONSISTENCY')
        try:
            plan = _read_json(job / 'poster-layer-plan.json')
            manifest = _read_json(job / 'layer_manifest.json')
        except (OSError, ValueError, json.JSONDecodeError):
            _append_failure(failures, 'MANIFEST_INCONSISTENCY')
            plan, manifest = {}, {}

        source = plan.get('source') if isinstance(plan.get('source'), dict) else {}
        width, height = source.get('width'), source.get('height')
        dimensions_valid = (isinstance(width, int) and not isinstance(width, bool) and width > 0
                            and isinstance(height, int) and not isinstance(height, bool) and height > 0)
        if not dimensions_valid:
            _append_failure(failures, 'MANIFEST_INCONSISTENCY')

        try:
            source_path = job / 'source.png'
            source_payload = _read_pinned_regular(source_path)
            source_digest = hashlib.sha256(source_payload).hexdigest()
            source_image, source_mode = _decode_rgb_png(source_payload)
            if source_mode not in ('RGB', 'RGBA') or (dimensions_valid and source_image.size != (width, height)):
                _append_failure(failures, 'SOURCE_DIMENSION_MISMATCH')
        except (OSError, UnidentifiedImageError, ValueError):
            _append_failure(failures, 'SOURCE_UNAVAILABLE')

        plan_layers = plan.get('layers') if isinstance(plan.get('layers'), list) else []
        manifest_layers = manifest.get('layers') if isinstance(manifest.get('layers'), list) else []
        plan_by_index = {entry.get('layer_index'): entry for entry in plan_layers
                         if isinstance(entry, dict) and isinstance(entry.get('layer_index'), int)}
        state_by_index = {entry.get('layer_index'): entry for entry in manifest_layers
                          if isinstance(entry, dict) and isinstance(entry.get('layer_index'), int)}
        if (not plan_layers or len(plan_by_index) != len(plan_layers)
                or len(state_by_index) != len(manifest_layers)
                or set(plan_by_index) != set(state_by_index)):
            _append_failure(failures, 'MANIFEST_INCONSISTENCY')
            conflicts.update(set(plan_by_index) | set(state_by_index))
        front_to_back = [plan_by_index[index] for index in sorted(plan_by_index)]
        z_orders = [entry.get('z_order') for entry in front_to_back]
        valid_z_order = (all(isinstance(value, int) and not isinstance(value, bool) and value > 0
                             for value in z_orders)
                         and all(z_orders[offset] > z_orders[offset - 1]
                                 for offset in range(1, len(z_orders))))
        if valid_z_order:
            order = [entry['layer_index'] for entry in sorted(
                front_to_back, key=lambda entry: entry['z_order'], reverse=True,
            )]
        else:
            order = sorted(plan_by_index, reverse=True)
            _append_failure(failures, 'INVALID_COMPOSITE_ORDER')
            conflicts.update(plan_by_index)

        owners = {}
        for index, layer in plan_by_index.items():
            included = layer.get('included_content')
            if not isinstance(included, list):
                _append_failure(failures, 'MANIFEST_INCONSISTENCY')
                conflicts.add(index)
                continue
            for item in included:
                key = json.dumps(item, ensure_ascii=False, sort_keys=True)
                if key in owners and owners[key] != index:
                    _append_failure(failures, 'DUPLICATE_OWNED_CONTENT')
                    conflicts.update((owners[key], index))
                else:
                    owners[key] = index

        plan_version = plan.get('plan_version')
        for index in order:
            planned = plan_by_index[index]
            state = state_by_index.get(index)
            if not isinstance(state, dict):
                continue
            candidate = _accepted_candidate(manifest, state, planned, plan_version)
            if (state.get('status') != 'ACCEPTED'
                    or state.get('accepted_plan_version') != plan_version
                    or candidate is None):
                _append_failure(failures, 'MANIFEST_INCONSISTENCY')
                conflicts.add(index)

            if candidate is not None:
                candidate_path_value = candidate.get('path')
                candidate_lexical = (Path(candidate_path_value)
                                     if isinstance(candidate_path_value, str) and candidate_path_value else None)
                candidate_lexical = (candidate_lexical if candidate_lexical is None or candidate_lexical.is_absolute()
                                     else job / candidate_lexical)
                candidate_lexical = (Path(os.path.abspath(candidate_lexical))
                                     if candidate_lexical is not None else None)
                try:
                    if (candidate_lexical is None or candidates_fd is None
                            or candidate_lexical.parent.resolve(strict=True) != physical_candidates
                            or candidate_lexical.suffix.lower() != '.png'):
                        raise OSError('candidate path outside candidates root')
                    candidate_payload = _read_pinned_regular_at(candidates_fd, candidate_lexical.name)
                    if hashlib.sha256(candidate_payload).hexdigest() != candidate.get('candidate_sha256'):
                        raise OSError('candidate digest mismatch')
                except OSError:
                    _append_failure(failures, 'MISSING_ACCEPTED_CANDIDATE')
                    conflicts.add(index)

            plan_fill = planned.get('fill_color')
            plan_mode = planned.get('compositing_mode')
            state_fill = state.get('fill_color')
            state_mode = state.get('compositing_mode')
            normalized_mode = plan_mode.strip().lower() if isinstance(plan_mode, str) else ''
            expected_fill = ALLOWED_KEYS.get(normalized_mode)
            if (expected_fill is None or not isinstance(plan_fill, str)
                    or plan_fill.upper() != expected_fill or state_fill != plan_fill
                    or state_mode != plan_mode):
                _append_failure(failures, 'INVALID_KEY_FIELDS')
                conflicts.add(index)

            inspection = state.get('visual_inspection') if isinstance(state.get('visual_inspection'), dict) else {}
            visual_codes = inspection.get('failure_codes') if isinstance(inspection.get('failure_codes'), list) else []
            if visual_codes or inspection.get('verdict') == 'HARD_REJECTED':
                _append_failure(failures, 'VISUAL_OWNERSHIP_BLOCKED')
                for code in visual_codes:
                    if isinstance(code, str):
                        _append_failure(failures, code)
                conflicts.add(index)

            raw_path = state.get('source_output')
            lexical = Path(raw_path) if isinstance(raw_path, str) and raw_path else None
            lexical = lexical if lexical is None or lexical.is_absolute() else job / lexical
            try:
                if (lexical is None or lexical.parent.resolve() != layers_root.resolve()
                        or lexical.suffix.lower() != '.png'):
                    raise OSError('canonical path outside layers root')
                payload = _read_pinned_regular(lexical)
                digest = hashlib.sha256(payload).hexdigest()
                image, original_mode = _decode_rgb_png(payload)
            except (OSError, UnidentifiedImageError, ValueError):
                _append_failure(failures, 'MISSING_ACCEPTED_LAYER')
                conflicts.add(index)
                continue
            binding = {
                'layer_index': index,
                'candidate_id': state.get('accepted_candidate_id'),
                'candidate_sha256': candidate.get('candidate_sha256') if candidate else None,
                'candidate_output': state.get('candidate_output'),
                'source_output': raw_path,
                'source_sha256': digest,
            }
            accepted_layers.append(binding)
            if state.get('source_sha256') != digest:
                _append_failure(failures, 'MANIFEST_INCONSISTENCY')
                conflicts.add(index)
            if original_mode != 'RGB':
                _append_failure(failures, 'NON_RGB_CANONICAL_LAYER')
                conflicts.add(index)
            if dimensions_valid and image.size != (width, height):
                _append_failure(failures, 'DIMENSION_MISMATCH')
                conflicts.add(index)
                continue
            if expected_fill is not None:
                opened_layers[index] = (image, normalized_mode, _key_mask(image, _hex_color(expected_fill)))

        measurements = {
            'source_sha256': source_digest,
            'total_pixels': width * height if dimensions_valid else 0,
            'coverage_ratio': 0.0,
            'missing_owned_pixels': 0,
            'overlap_pixels': 0,
            'undeclared_overlap_pixels': 0,
            'mismatch_pixels': 0,
            'unowned_mismatch_pixels': 0,
            'source_similarity': 0.0,
            'mean_absolute_error': 255.0,
            'max_channel_error': 255,
            'per_layer': [],
            'thresholds': {
                'channel_tolerance': CHANNEL_TOLERANCE,
                'minimum_source_similarity': MIN_SOURCE_SIMILARITY,
                'maximum_mean_absolute_error': MAX_MEAN_ABSOLUTE_ERROR,
                'minimum_coverage_ratio': MIN_COVERAGE_RATIO,
            },
        }

        pixels_ready = (source_image is not None and dimensions_valid
                        and source_image.size == (width, height)
                        and set(opened_layers) == set(plan_by_index))
        if pixels_ready:
            total = width * height
            masks = {index: opened_layers[index][2] for index in order}
            mask_data = {index: list(_pixel_data(masks[index])) for index in order}
            occupied = [sum(1 for index in order if mask_data[index][offset]) for offset in range(total)]
            missing_offsets = [offset for offset, count in enumerate(occupied) if count == 0]
            overlap_offsets = [offset for offset, count in enumerate(occupied) if count > 1]
            undeclared = set()
            overlap_conflicts = set()
            for front_position, front_index in enumerate(sorted(plan_by_index)):
                for back_index in sorted(plan_by_index)[front_position + 1:]:
                    pair_overlap = [offset for offset in range(total)
                                    if mask_data[front_index][offset] and mask_data[back_index][offset]]
                    if pair_overlap and not _declares_occlusion(plan_by_index[front_index], plan_by_index[back_index]):
                        undeclared.update(pair_overlap)
                        overlap_conflicts.update((front_index, back_index))

            composite = Image.new('RGB', (width, height), (0, 0, 0))
            for index in order:
                image, mode, mask = opened_layers[index]
                composite = _composite_layer(composite, image, mask, mode)

            source_pixels = list(_pixel_data(source_image))
            composite_pixels = list(_pixel_data(composite))
            channel_error_sum = 0
            maximum_error = 0
            mismatch_offsets = []
            for offset, (actual, expected) in enumerate(zip(composite_pixels, source_pixels)):
                errors = [abs(actual[channel] - expected[channel]) for channel in range(3)]
                channel_error_sum += sum(errors)
                maximum_error = max(maximum_error, *errors)
                if max(errors) > CHANNEL_TOLERANCE:
                    mismatch_offsets.append(offset)
            mismatch_set = set(mismatch_offsets)
            unowned_mismatch = sum(1 for offset in mismatch_offsets if occupied[offset] == 0)
            similarity = (total - len(mismatch_offsets)) / total
            mean_error = channel_error_sum / (total * 3)
            coverage = (total - len(missing_offsets)) / total

            measurements.update({
                'coverage_ratio': round(coverage, 6),
                'missing_owned_pixels': len(missing_offsets),
                'overlap_pixels': len(overlap_offsets),
                'undeclared_overlap_pixels': len(undeclared),
                'mismatch_pixels': len(mismatch_offsets),
                'unowned_mismatch_pixels': unowned_mismatch,
                'source_similarity': round(similarity, 6),
                'mean_absolute_error': round(mean_error, 6),
                'max_channel_error': maximum_error,
                'per_layer': [
                    {
                        'layer_index': index,
                        'owned_pixels': sum(1 for value in mask_data[index] if value),
                        'mismatched_owned_pixels': sum(1 for offset in mismatch_set if mask_data[index][offset]),
                    }
                    for index in order
                ],
            })
            if missing_offsets or coverage < MIN_COVERAGE_RATIO:
                _append_failure(failures, 'MISSING_OWNED_PIXELS')
                _append_failure(failures, 'COMPLETION_MISSING')
                for index in order:
                    if any(not mask_data[index][offset] for offset in missing_offsets):
                        conflicts.add(index)
            if undeclared:
                _append_failure(failures, 'OWNERSHIP_OVERLAP')
                _append_failure(failures, 'OCCLUDER_OWNERSHIP_ERROR')
                conflicts.update(overlap_conflicts)
            excessive_mismatch = (similarity < MIN_SOURCE_SIMILARITY
                                  or mean_error > MAX_MEAN_ABSOLUTE_ERROR)
            if excessive_mismatch:
                _append_failure(failures, 'SOURCE_RECOMPOSITION_MISMATCH')
                if mismatch_offsets:
                    _append_failure(failures, 'FOREIGN_CONTENT_LEAK')
                    for index in order:
                        if any(mask_data[index][offset] for offset in mismatch_offsets):
                            conflicts.add(index)

        checks = {
            'dimensions': dimensions_valid and source_image is not None
                          and source_image.size == (width, height)
                          and all(value[0].size == (width, height) for value in opened_layers.values()),
            'order': not any(code == 'INVALID_COMPOSITE_ORDER' for code in failures),
            'key_fields': not any(code == 'INVALID_KEY_FIELDS' for code in failures),
            'coverage': pixels_ready and measurements['coverage_ratio'] >= MIN_COVERAGE_RATIO,
            'source_similarity': (pixels_ready
                                  and measurements['source_similarity'] >= MIN_SOURCE_SIMILARITY
                                  and measurements['mean_absolute_error'] <= MAX_MEAN_ABSOLUTE_ERROR),
            'ownership': pixels_ready and measurements['undeclared_overlap_pixels'] == 0,
            'foreign_content': (pixels_ready
                                and measurements['source_similarity'] >= MIN_SOURCE_SIMILARITY
                                and measurements['mean_absolute_error'] <= MAX_MEAN_ABSOLUTE_ERROR),
            'accepted_binding': not any(code in ('MANIFEST_INCONSISTENCY', 'MISSING_ACCEPTED_CANDIDATE')
                                        for code in failures),
        }

        if failures:
            _unlink_preview(audit_fd)
        elif audit_fd is not None and composite is not None:
            try:
                _write_preview(audit_fd, composite)
            except OSError:
                _append_failure(failures, 'AUDIT_DIRECTORY_UNSAFE')
                _unlink_preview(audit_fd)
        else:
            _append_failure(failures, 'AUDIT_DIRECTORY_UNSAFE')

        return {
            'status': 'passed' if not failures else 'failed',
            'composite_order': order,
            'failure_codes': failures,
            'conflict_layers': sorted(index for index in conflicts if isinstance(index, int)),
            'accepted_layers': accepted_layers,
            'checks': checks,
            'measurements': measurements,
            'preview_path': str(preview_path),
        }
    finally:
        if audit_fd is not None:
            _close_directory(audit_fd)
        if candidates_fd is not None:
            _close_directory(candidates_fd)


def main(argv=None):
    arguments = _arguments(argv)
    print(json.dumps(audit_job(arguments.job_directory), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
