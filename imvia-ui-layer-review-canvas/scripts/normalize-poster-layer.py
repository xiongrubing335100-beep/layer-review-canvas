import argparse
import json
import math
import os
import sys
import tempfile
from collections import deque
from pathlib import Path

from PIL import Image, UnidentifiedImageError


class ValidationError(ValueError):
    pass


def _fail(code, detail):
    raise ValidationError(f'{code}: {detail}')


def _rgb_fill(fill_color):
    if not isinstance(fill_color, str) or len(fill_color) != 7 or not fill_color.startswith('#'):
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'fill color must be #RRGGBB')
    try:
        return tuple(int(fill_color[index:index + 2], 16) for index in (1, 3, 5))
    except ValueError:
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'fill color must be #RRGGBB')


def _validate_key_field(image, fill):
    width, height = image.size
    pixels = image.load()
    visited = bytearray(width * height)
    queue = deque()

    def enqueue(x, y):
        index = y * width + x
        if not visited[index] and pixels[x, y] == fill:
            visited[index] = 1
            queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    field_pixels = 0
    while queue:
        x, y = queue.popleft()
        field_pixels += 1
        if x > 0:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y > 0:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)

    minimum = max(2, math.ceil(width * height * 0.02))
    if field_pixels < minimum:
        _fail('KEY_UNUSABLE', 'candidate is missing a usable edge-connected key field')

    # Near-key pixels on the canvas boundary indicate a contaminated field rather
    # than source artwork. Exact key pixels remain the only background authority.
    boundary = [(x, 0) for x in range(width)] + [(x, height - 1) for x in range(width)]
    boundary += [(0, y) for y in range(1, height - 1)] + [(width - 1, y) for y in range(1, height - 1)]
    for point in boundary:
        color = pixels[point]
        if color != fill and max(abs(color[channel] - fill[channel]) for channel in range(3)) <= 8:
            _fail('KEY_UNUSABLE', 'candidate key field contains non-uniform near-key pixels')


def normalize_candidate(image, source_size, fill_color):
    if image.mode not in ('RGB', 'RGBA'):
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'candidate must be RGB or RGBA')
    if image.mode == 'RGBA' and image.getextrema()[3] != (255, 255):
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'candidate must not contain mixed alpha')

    try:
        source_width, source_height = source_size
    except (TypeError, ValueError):
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'source size is invalid')
    if not isinstance(source_width, int) or not isinstance(source_height, int) or source_width < 1 or source_height < 1:
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'source size must contain positive integers')
    width, height = image.size
    if width * source_height != height * source_width:
        _fail('REGISTRATION_UNCERTAIN', 'candidate aspect ratio differs from the source canvas')

    fill = _rgb_fill(fill_color)
    rgb = image.convert('RGB')
    _validate_key_field(rgb, fill)

    scale = min(source_width / width, source_height / height)
    scaled_size = (round(width * scale), round(height * scale))
    if scaled_size[0] > source_width or scaled_size[1] > source_height:
        _fail('REGISTRATION_UNCERTAIN', 'candidate would require cropping')
    if scaled_size != image.size:
        rgb = rgb.resize(scaled_size, Image.Resampling.LANCZOS)
    output = Image.new('RGB', (source_width, source_height), fill)
    offset = ((source_width - scaled_size[0]) // 2, (source_height - scaled_size[1]) // 2)
    output.paste(rgb, offset)
    return output


def _validate_compositing_mode(fill_color, compositing_mode):
    normalized_fill = fill_color.upper()
    mode = compositing_mode.strip().lower()
    expected = '#00FF00' if mode == 'normal' else '#000000' if mode in ('screen', 'add', 'screen/add') else None
    if expected is None or normalized_fill != expected:
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'fill color conflicts with compositing mode')
    return normalized_fill


def _arguments(argv=None):
    parser = argparse.ArgumentParser(description='Normalize an accepted full-canvas poster layer without generation.')
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--source-width', required=True, type=int)
    parser.add_argument('--source-height', required=True, type=int)
    parser.add_argument('--fill-color', required=True)
    parser.add_argument('--compositing-mode', required=True)
    return parser.parse_args(argv)


def main(argv=None):
    arguments = _arguments(argv)
    fill_color = _validate_compositing_mode(arguments.fill_color, arguments.compositing_mode)
    output_path = Path(arguments.output).resolve()
    output_path.parent.mkdir(parents=False, exist_ok=True)
    temporary_path = None
    try:
        with Image.open(arguments.input) as opened:
            if opened.format != 'PNG':
                _fail('CANVAS_OR_GREEN_FIELD_INVALID', 'input must decode as PNG')
            opened.load()
            normalized = normalize_candidate(
                opened,
                (arguments.source_width, arguments.source_height),
                fill_color,
            )
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f'.{output_path.name}.', suffix='.tmp.png', dir=output_path.parent,
        )
        os.close(descriptor)
        temporary_path = Path(temporary_name)
        normalized.save(temporary_path, format='PNG')
        os.replace(temporary_path, output_path)
        temporary_path = None
        print(json.dumps({
            'output': str(output_path), 'width': normalized.width, 'height': normalized.height,
            'mode': normalized.mode, 'fill_color': fill_color,
        }))
        return 0
    except (UnidentifiedImageError, OSError) as error:
        _fail('CANVAS_OR_GREEN_FIELD_INVALID', f'PNG is unreadable: {error}')
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except ValidationError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
