"""Read-only document replay; writes diagnostic images, never a candidate."""
import argparse
import importlib.util
import json
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('manifest')
parser.add_argument('raw')
parser.add_argument('output')
parser.add_argument('--version', type=int, choices=(2,3), default=2)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('pixels', Path(__file__).with_name('v2-region-pixels.py'))
pixels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pixels)
manifest = json.loads(Path(args.manifest).read_text())
manifest['nativeRgbaRequirements'] = {'version': args.version}
result, audit = pixels.render_region(manifest, args.raw)
source = Image.open(manifest['selectedCropPath']).convert('RGBA')
audit['diagnosticOnly'] = True
audit['allRgbMatchesSource'] = result.convert('RGB').tobytes() == source.convert('RGB').tobytes()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=False)
result.save(output / 'preview.png')
Image.alpha_composite(Image.new('RGBA', result.size, '#252525'), result).save(output / 'preview-dark.png')
(output / 'audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2))
print(json.dumps(audit))
