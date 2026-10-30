"""Render native RGBA inspection artifacts without finalizing a candidate."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from PIL import Image

spec = importlib.util.spec_from_file_location('region_pixels', Path(__file__).with_name('v2-region-pixels.py'))
pixels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pixels)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--raw', required=True)
    parser.add_argument('--output-dir')
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    if manifest.get('maskProvider') != 'native_rgba':
        raise ValueError('NATIVE_RGBA_REQUIRED')
    raw = pixels.inside_root(manifest['outputRoot'], args.raw)
    result, audit = pixels.render_region(manifest, raw)
    folder = Path(args.output_dir).resolve() if args.output_dir else Path(args.manifest).resolve().parent
    folder.mkdir(parents=True, exist_ok=True)
    for name, image in [('preview.png', result),
                        ('preview-dark.png', Image.alpha_composite(Image.new('RGBA', result.size, '#252525'), result)),
                        ('preview-light.png', Image.alpha_composite(Image.new('RGBA', result.size, '#eeeeee'), result))]:
        with (folder / name).open('xb') as stream:
            image.save(stream, format='PNG')
    report = {'rawSha256': hashlib.sha256(raw.read_bytes()).hexdigest(),
              'finalPreview': {'rgbaSha256': hashlib.sha256(result.tobytes()).hexdigest()}, 'pixelAudit': audit}
    with (folder / 'inspection.json').open('x') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
    print(json.dumps(report))
