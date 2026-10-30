"""Independent coverage fixtures: textured material is not background leakage."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as nd

spec = importlib.util.spec_from_file_location(
    'source_matte', Path(__file__).with_name('source-guided-matte.py'))
matting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matting)


def reflective_fixture():
    y, x = np.indices((160, 200))
    distance = np.hypot(x-100, y-80)
    alpha = np.clip(np.minimum(distance-43, 50-distance)+.5, 0, 1)
    alpha = np.maximum(alpha, np.clip(np.minimum(26-abs(x-100), 16-abs(y-80))+.5, 0, 1))
    foreground = np.dstack((150+95*np.sin(x*.7), 100+80*np.cos(y*.9), 60+40*np.sin((x+y)*.4)))
    background = np.dstack((240+10*np.sin(x/150), 228+10*np.cos(y/190), 193+15*np.sin(x/190)))
    alpha = np.rint(alpha*255).astype(np.uint8)
    coverage = alpha[..., None]/255
    rgb = np.rint(coverage*foreground+(1-coverage)*background).clip(0, 255).astype(np.uint8)
    return rgb, alpha


class AlphaBoundaryEvidenceTests(unittest.TestCase):
    def audit(self, rgb, alpha):
        visible = alpha >= 128
        return matting.source_contour_evidence(
            rgb, visible, np.zeros_like(visible), material=True, alpha=alpha)[0]

    def test_known_correct_reflective_ring_is_not_rejected_for_nonmonotone_color(self):
        rgb, alpha = reflective_fixture()
        before = alpha.copy()
        audit = self.audit(rgb, alpha)
        self.assertGreaterEqual(audit['boundaryMatchRatio'], .90, audit)
        self.assertLessEqual(audit['longestUnsupportedRun'], 12, audit)
        np.testing.assert_array_equal(alpha, before)

    def test_three_pixel_displacements_still_fail(self):
        rgb, alpha = reflective_fixture()
        for dx, dy in [(3, 0), (-3, 0), (0, 3), (0, -3), (3, 3), (-3, -3)]:
            with self.subTest(dx=dx, dy=dy):
                shifted = cv2.warpAffine(alpha, np.float32([[1, 0, dx], [0, 1, dy]]), (200, 160))
                audit = self.audit(rgb, shifted)
                self.assertTrue(audit['boundaryMatchRatio'] < .9 or audit['longestUnsupportedRun'] > 12, audit)

    def test_invented_hole_and_background_leak_are_not_certified(self):
        rgb, alpha = reflective_fixture()
        hole = alpha.copy(); hole[72:88, 90:110] = 0
        leak = alpha.copy(); leak[40:120, 25:40] = 255
        for label, candidate in [('hole', hole), ('leak', leak)]:
            with self.subTest(label=label):
                audit = self.audit(rgb, candidate)
                self.assertTrue(audit['boundaryMatchRatio'] < .9 or audit['longestUnsupportedRun'] > 12, audit)

    def test_new_evidence_does_not_certify_cast_shadow_or_source_texture(self):
        shape = np.zeros((100, 140), np.uint8); shape[20:80, 30:115] = 255
        points = np.zeros_like(shape, bool); points[35:65, 30] = True
        rgb = np.full((*shape.shape, 3), 180.)
        rgb[:, 30:35] = 165; rgb[:, 35:115] = 235
        self.assertFalse(matting.coverage_boundary_evidence(rgb, shape, points).any())
        y, x = np.indices(shape.shape)
        for field in (140+x*.3+y*.1, 140+30*np.sin(x*1.5)+10*np.cos(y)):
            rgb = np.repeat(field[..., None], 3, axis=2)
            self.assertFalse(matting.coverage_boundary_evidence(rgb, shape, points).any())

    def test_low_coverage_tail_is_tested_as_a_mixture_not_as_pure_background(self):
        alpha = np.zeros((80, 100), np.uint8)
        alpha[15:65, 30:80] = 255
        alpha[15:65, 29] = 7
        mixture = alpha[..., None]/255
        rgb = np.rint(mixture*np.array([20, 80, 130])
                      +(1-mixture)*np.array([240, 220, 180])).astype(np.uint8)
        points = np.zeros_like(alpha, bool); points[30:50, 30] = True
        self.assertTrue(np.all(matting.coverage_boundary_evidence(rgb, alpha, points)[points]))
        # Removing the real tail is not licensed by the fitted background.
        wrong = alpha.copy(); wrong[:, 29] = 0
        self.assertFalse(matting.coverage_boundary_evidence(rgb, wrong, points).any())

    def test_public_refinement_preserves_a_source_verified_composite(self):
        rgb, alpha = reflective_fixture()
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'ring', 'point': [100, 32]},
                             {'name': 'plate', 'point': [100, 80]}],
                 'holes': [{'id': 1, 'treatment': 'preserve', 'reason': 'visible source background'}]}
        result, audit, colors = matting.refine_source_matte(
            Image.fromarray(rgb), Image.fromarray(alpha), 'text',
            semantic_topology=guide, recover_foreground=True)
        self.assertEqual(audit['status'], 'passed', audit)
        np.testing.assert_array_equal(np.asarray(result), alpha)
        opaque = np.asarray(result) == 255
        np.testing.assert_array_equal(np.asarray(colors)[opaque], rgb[opaque])

    def test_correct_outer_edge_does_not_certify_a_filled_in_counter(self):
        rgb, alpha = reflective_fixture()
        filled = nd.binary_fill_holes(alpha >= 128).astype(np.uint8)*255
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'ring', 'point': [100, 32]},
                             {'name': 'plate', 'point': [100, 80]}], 'holes': []}
        result, audit, _ = matting.refine_source_matte(
            Image.fromarray(rgb), Image.fromarray(filled), 'text',
            semantic_topology=guide, recover_foreground=True)
        self.assertTrue(result.getpixel((100, 50)) < 128 or audit['status'] != 'passed', audit)

    def test_small_shared_offset_is_corrected_without_resegmenting_thin_parts(self):
        rgb, alpha = reflective_fixture()
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'ring', 'point': [100, 32]},
                             {'name': 'plate', 'point': [100, 80]}],
                 'holes': [{'id': 1, 'treatment': 'preserve', 'reason': 'visible source background'}]}
        for dx, dy in [(3, 2), (-3, 0), (0, -3)]:
            with self.subTest(dx=dx, dy=dy):
                shifted = cv2.warpAffine(alpha, np.float32([[1, 0, dx], [0, 1, dy]]), (200, 160))
                result, audit, colors = matting.refine_source_matte(
                    Image.fromarray(rgb), Image.fromarray(shifted), 'text',
                    semantic_topology=guide, recover_foreground=True)
                self.assertEqual(audit['status'], 'passed', audit)
                np.testing.assert_array_equal(np.asarray(result), alpha)
                opaque = np.asarray(result) == 255
                np.testing.assert_array_equal(np.asarray(colors)[opaque], rgb[opaque])

    @unittest.skipUnless(shutil.which('node'), 'Node required for cross-runtime PNG/PSD check')
    def test_renderer_audit_and_png_remain_usable_by_v2_delivery_and_psd(self):
        # This is an independent synthetic integration fixture, not a model
        # result and not an acceptance claim about the real gold title.
        rgb, alpha = reflective_fixture()
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'ring', 'point': [100, 32]},
                             {'name': 'plate', 'point': [100, 80]}],
                 'holes': [{'id': 1, 'treatment': 'preserve', 'reason': 'visible source background'}]}
        pixel_spec = importlib.util.spec_from_file_location(
            'pixels', Path(__file__).with_name('v2-region-pixels.py'))
        pixels = importlib.util.module_from_spec(pixel_spec); pixel_spec.loader.exec_module(pixels)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            Image.fromarray(rgb).save(root/'source.png')
            Image.fromarray(alpha).save(root/'mask.png')
            manifest = {'schemaVersion': 2, 'route': 'extract_mask', 'maskProvider': 'imagegen_matte',
                        'outputRoot': str(root),
                        'removeBackground': True, 'selectedCropPath': str(root/'source.png'),
                        'semanticTopology': guide, 'semanticRequirements': {'version': 1},
                        'snapshot': {'processingCategory': 'text', 'bounds':
                                     {'x': 37, 'y': 91, 'width': 200, 'height': 160}, 'paths': [],
                                     'strategy': {'repairPaths': []}}}
            result, audit = pixels.render_region(manifest, root/'mask.png')
            self.assertEqual(audit['status'], 'candidate', audit)
            self.assertEqual(audit['sourceGeometryAlignment']['status'], 'passed', audit)
            self.assertEqual(audit['placement'], {'x': 37, 'y': 91})
            opaque = np.asarray(result)[..., 3] == 255
            np.testing.assert_array_equal(np.asarray(result)[opaque, :3], rgb[opaque])
            result.save(root/'result.png')
            (root/'audit.json').write_text(json.dumps(audit))
            script = """
                import assert from 'node:assert/strict';
                import {readFile} from 'node:fs/promises';
                import {sourceGeometryMatches} from './src/v2/candidate-review.js';
                import {readPosterPngBytes} from './src/poster-png.js';
                import {composeNormal} from './src/v2/pixels.js';
                import {encodePsd,inspectPsd} from './src/v2/psd-codec.mjs';
                const [pngPath,auditPath] = process.argv.slice(1);
                const audit = JSON.parse(await readFile(auditPath,'utf8'));
                const candidate = {pixelAudit:audit,alpha:audit.alpha,semanticRequirements:{version:1},
                    review:{provider:'imagegen_matte',visualReview:{status:'passed'}}};
                assert.equal(sourceGeometryMatches({processingCategory:'text',strategy:{removeBackground:true}},candidate),true);
                const png=readPosterPngBytes(await readFile(pngPath));
                const image={width:png.width,height:png.height,data:new Uint8ClampedArray(png.pixels)};
                const layer={name:'coverage integration',image,placement:audit.placement};
                const composite=composeNormal({width:400,height:300,layers:[layer]});
                const psd=inspectPsd(encodePsd({width:400,height:300,layers:[layer],composite,availableMemory:8*1024**3}),{availableMemory:8*1024**3});
                assert.deepEqual(psd.layers[0].placement,{x:37,y:91});
                assert.ok(Buffer.from(psd.layers[0].image.data).equals(Buffer.from(image.data)));
                console.log('V2 eligibility, PNG decode, PSD RGBA and placement passed');
            """
            checked = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script,
                                      str(root/'result.png'), str(root/'audit.json')],
                                     cwd=Path(__file__).resolve().parents[1], text=True, capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == '__main__':
    unittest.main()
