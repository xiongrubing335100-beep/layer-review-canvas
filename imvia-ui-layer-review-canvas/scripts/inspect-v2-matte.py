"""Inspect/preview a raw matte in frozen crop coordinates; never finalize a job."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from PIL import Image
import numpy as np


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name+'.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def inspect(manifest_path, raw_path, report_path=None, preview_path=None, stage='topology'):
    manifest = json.loads(Path(manifest_path).read_text())
    if manifest.get('route') != 'extract_mask' or manifest.get('maskProvider') != 'imagegen_matte':
        raise ValueError('SEMANTIC_INSPECTION_ROUTE_INVALID')
    bounds = manifest['snapshot']['bounds']
    source = Image.open(manifest['selectedCropPath']).convert('RGBA')
    if source.size != (bounds['width'], bounds['height']):
        raise ValueError('SELECTED_CROP_DIMENSIONS_MISMATCH')
    mapping = json.loads(Path(manifest['mappingPath']).read_text()) if manifest.get('mappingPath') else manifest.get('mapping')
    pixels, semantic, matting = module('v2-region-pixels'), module('semantic-matte'), module('source-guided-matte')
    mask = pixels.matte_mask(raw_path, mapping, source.size, 'imagegen_matte')
    scope = pixels.path_mask(manifest['snapshot'].get('paths', []), bounds)
    aligned, alignment, _, _, _ = matting.prepare_registered_matte(source, mask, scope)
    _, holes = semantic.hole_components(mask, alignment.get('matrix'))
    _, notches = semantic.material_notch_components(aligned)
    raw_hash = hashlib.sha256(Path(raw_path).read_bytes()).hexdigest()
    result = {'coordinateSpace': 'selected_region_pixels', 'rawSha256': raw_hash,
              'sourceFingerprint': manifest['envelope']['sourceFingerprint'], 'bounds': bounds, 'holes': holes,
              'materialNotchProposals': notches,
              'globalRegistration': alignment,
              'purpose': 'executor source inspection; not a delivery certificate'}
    if report_path:
        report = json.loads(Path(report_path).read_text())
        if (any(report.get(key) != value for key, value in manifest['envelope'].items()
                if key in ('attemptId', 'dispatchId', 'authorizationId', 'snapshotId', 'sourceFingerprint'))
                or report.get('rawSha256') != raw_hash):
            raise ValueError('SEMANTIC_RAW_BINDING_MISMATCH')
        corrected, audit, evidence = semantic.prepare_topology(source, mask, report['semanticTopology'], scope,
                                                              alignment.get('matrix'))
        alpha = np.minimum(np.asarray(corrected), np.asarray(scope))
        alpha = np.rint(alpha.astype(float)*np.asarray(source.getchannel('A'))/255).astype(np.uint8)
        semantic.verify_topology(alpha, audit, evidence)
        result['topologyPreview'] = audit
        if stage == 'final':
            # Same pure renderer used by the finalizer: no candidate registry,
            # document revision, execution event or extra model call is created.
            source, pixel_audit = pixels.render_region(
                {**manifest, 'semanticTopology': report['semanticTopology']}, raw_path)
            result['pixelAudit'] = pixel_audit
            result['rgbaSha256'] = hashlib.sha256(source.tobytes()).hexdigest()
        else:
            source.putalpha(Image.fromarray(alpha))
        if preview_path:
            # Preview contains source RGB, never generated RGB or a resized crop.
            with Path(preview_path).open('xb') as output:
                source.save(output, format='PNG')
            result['previewPath'] = str(Path(preview_path).resolve())
    elif preview_path:
        raise ValueError('SEMANTIC_REVIEW_REQUIRED')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--raw', required=True)
    parser.add_argument('--report')
    parser.add_argument('--preview')
    parser.add_argument('--stage', choices=('topology', 'final'), default='topology')
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.manifest, args.raw, args.report, args.preview, args.stage), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
