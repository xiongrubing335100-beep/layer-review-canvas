"""Semantic topology is independent of source-edge contrast."""
import importlib.util
from pathlib import Path
import unittest
import json
import hashlib
import subprocess
import sys
import tempfile
import numpy as np
from PIL import Image, ImageFilter


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


matting = module('source-guided-matte')
semantic = module('semantic-matte')


class SemanticMatteTests(unittest.TestCase):
    def test_material_near_white_interior_is_opaque_without_changing_coverage_edges(self):
        values=np.zeros((70,90),np.uint8);values[10:60,10:80]=254
        values[10:60,10]=180;values[10:60,11]=248
        values[30:40,40:50]=0
        source=Image.new('RGBA',(90,70),(180,120,60,255))
        guide={'version':1,'coordinateSpace':'selected_region_pixels','profile':'material_composite',
            'objects':[{'name':'opaque plate','point':[25,25]}],
            'holes':[{'id':1,'treatment':'preserve','reason':'true background counter'}]}
        result,audit,_=semantic.prepare_topology(source,Image.fromarray(values),guide)
        actual=np.asarray(result)
        self.assertEqual(int(actual[25,25]),255,'near-white model noise is not translucent solid material')
        np.testing.assert_array_equal(actual[:,10:13],values[:,10:13])
        np.testing.assert_array_equal(actual[29:41,39:51],values[29:41,39:51])
        self.assertGreater(audit['normalizedOpaqueInteriorPixels'],0)
        source.putalpha(Image.new('L',source.size,210))
        native,_,_=semantic.prepare_topology(source,Image.fromarray(values),guide)
        np.testing.assert_array_equal(np.asarray(native),values)
        organic,_,_=semantic.prepare_topology(Image.new('RGBA',source.size,(180,120,60,255)),
            Image.fromarray(values),{**guide,'profile':'organic_subject'})
        np.testing.assert_array_equal(np.asarray(organic),values)

    def fixture(self, material=True):
        truth = np.zeros((100, 160), np.uint8)
        truth[20:80, 30:130] = 255
        proposal = truth.copy()
        proposal[43:51, 60:95] = 0
        yy, xx = np.indices(truth.shape)
        background = np.stack((250+xx*.005, 160+yy*.05, 130+xx*.07), axis=2)
        background[xx < 28] = [245, 145, 40]
        if not material:
            truth[43:51, 60:95] = 0
        soft = np.asarray(Image.fromarray(truth).filter(ImageFilter.GaussianBlur(1)))/255
        rgb = np.rint(background*(1-soft[..., None])+np.array([250,196,215])*soft[..., None]).astype(np.uint8)
        if material:
            rgb[43:51, 60:95] = [100,75,80]
        return Image.fromarray(rgb), Image.fromarray(proposal)

    def guide(self, treatment='fill_material'):
        return {'version': 1, 'coordinateSpace': 'selected_region_pixels', 'profile': 'material_composite',
                'objects': [{'name': 'opaque card', 'point': [45,60]}],
                'holes': [{'id': 1, 'treatment': treatment, 'reason': 'source-inspected interior'}]}

    def test_source_inspected_dark_material_is_restored_before_geometric_refinement(self):
        source, proposal = self.fixture()
        # Without independent semantic input the old code certified this false hole.
        alpha, audit = matting.refine_source_matte(source, proposal, 'text', semantic_topology=self.guide())
        self.assertEqual(np.asarray(alpha)[47,75], 255)
        self.assertEqual(audit['semanticTopology']['restoredHoleIds'], [1])
        self.assertEqual(audit['status'], 'passed')

    def test_a_real_counter_is_not_filled_by_the_material_repair(self):
        source, proposal = self.fixture(material=False)
        alpha, audit = matting.refine_source_matte(source, proposal, 'text', semantic_topology=self.guide('preserve'))
        self.assertEqual(np.asarray(alpha)[47,75], 0)
        self.assertEqual(audit['semanticTopology']['restoredHoleIds'], [])
        self.assertEqual(audit['status'], 'passed')

    def test_global_alignment_carries_material_hole_ids_but_not_source_anchors(self):
        import cv2
        source, proposal = self.fixture()
        moved = Image.fromarray(cv2.warpAffine(np.asarray(proposal),
            np.float32([[1, 0, 12], [0, 1, -12]]), proposal.size))
        alpha, audit = matting.refine_source_matte(source, moved, 'text', semantic_topology=self.guide())
        self.assertEqual(alpha.getpixel((75,47)), 255)
        self.assertEqual(alpha.getpixel((135,25)), 0, 'the offset mask must not retain page background')
        self.assertEqual(audit['semanticTopology']['restoredHoleIds'], [1])
        self.assertEqual(audit['status'], 'passed', audit)

    def test_unclassified_or_duplicate_holes_do_not_get_a_semantic_pass(self):
        source, proposal = self.fixture()
        for holes in ([], self.guide()['holes']*2):
            guide = {**self.guide(), 'holes': holes}
            with self.assertRaisesRegex(ValueError, 'SEMANTIC_HOLE_COVERAGE_MISMATCH'):
                matting.refine_source_matte(source, proposal, 'text', semantic_topology=guide)

    def test_semantics_cannot_fill_the_exterior_or_override_a_user_exclusion(self):
        source, proposal = self.fixture()
        guide = {**self.guide(), 'holes': [{'id': 0, 'treatment': 'fill_material', 'reason': 'exterior'}]}
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_HOLE_COVERAGE_MISMATCH'):
            matting.refine_source_matte(source, proposal, 'text', semantic_topology=guide)
        scope = np.full((100,160), 255, np.uint8); scope[43:51,60:95] = 0
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_REPAIR_OUTSIDE_SELECTION'):
            matting.refine_source_matte(source, proposal, 'text', semantic_topology=self.guide(), scope=Image.fromarray(scope))

    def test_missing_requested_object_is_not_certified_complete(self):
        source, proposal = self.fixture()
        guide = {**self.guide(), 'objects': [{'name': 'missing attachment', 'point': [5,5]}]}
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_OBJECT_MISSING'):
            matting.refine_source_matte(source, proposal, 'text', semantic_topology=guide)

    def test_a_counter_collapsed_to_one_pixel_is_not_preserved(self):
        source, proposal = self.fixture(material=False)
        _, audit, evidence = semantic.prepare_topology(source, proposal, self.guide('preserve'))
        broken = np.asarray(proposal).copy()
        broken[43:51,60:95] = 255
        broken[47,75] = 0
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_COUNTER_LOST'):
            semantic.verify_topology(broken, audit, evidence)

    def test_subpixel_registration_preserves_tiny_counter_coverage(self):
        # A one-pixel hole translated by half a pixel covers four pixels at
        # 25% each. None is below alpha 128; its area did not disappear.
        import cv2
        values = np.zeros((50, 50), np.uint8)
        values[10:40, 10:40] = 255
        values[25, 25] = 0
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'plate', 'point': [15, 15]}],
                 'holes': [{'id': 1, 'treatment': 'preserve', 'reason': 'source pinhole'}]}
        moved, audit, evidence = semantic.prepare_topology(
            Image.new('RGB', (50, 50), 'white'), Image.fromarray(values), guide,
            transform=np.float32([[1, 0, .5], [0, 1, .5]]))
        self.assertEqual(moved.getpixel((25, 25)), 191)
        semantic.verify_topology(np.asarray(moved), audit, evidence)
        self.assertEqual(audit['status'], 'passed')
        # Filling the hole or merely reducing opacity across the entire plate
        # is not preservation of an enclosed transparent region.
        for invalid in (np.where(np.asarray(moved) > 0, 255, 0).astype(np.uint8),
                        np.minimum(np.asarray(moved), 191).astype(np.uint8)):
            with self.assertRaisesRegex(ValueError, 'SEMANTIC_COUNTER_LOST'):
                semantic.verify_topology(invalid, dict(audit), evidence)

    def test_an_existing_antialiased_pinhole_is_not_rejected_by_coverage_fallback(self):
        values = np.zeros((50, 50), np.uint8)
        values[10:40, 10:40] = 255
        values[24:27, 24:27] = 180
        values[25, 25] = 100
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'plate', 'point': [15, 15]}],
                 'holes': [{'id': 1, 'treatment': 'preserve', 'reason': 'source pinhole'}]}
        unchanged, audit, evidence = semantic.prepare_topology(
            Image.new('RGB', (50, 50), 'white'), Image.fromarray(values), guide)
        semantic.verify_topology(np.asarray(unchanged), audit, evidence)
        self.assertEqual(audit['status'], 'passed')

    def test_shared_deformation_transports_hole_identity_but_not_source_anchors(self):
        import cv2
        values = np.zeros((70, 90), np.uint8)
        values[10:60, 10:80] = 255
        values[35, 45] = 0
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels', 'profile': 'material_composite',
                 'objects': [{'name': 'plate', 'point': [15, 15]}],
                 'holes': [{'id': 1, 'treatment': 'preserve', 'reason': 'source pinhole'}]}
        _, audit, evidence = semantic.prepare_topology(
            Image.new('RGB', (90, 70), 'white'), Image.fromarray(values), guide)
        y, x = np.indices(values.shape, dtype=np.float32)
        inverse_map = (x-4.5, y+.5)
        moved = cv2.remap(values, *inverse_map, cv2.INTER_LINEAR)
        moved_audit, moved_evidence = semantic.transport_counter_evidence(audit, evidence, inverse_map)
        semantic.verify_topology(moved, moved_audit, moved_evidence)
        self.assertEqual(moved_audit['status'], 'passed')
        self.assertIs(moved_evidence[2], evidence[2])
        self.assertIs(moved_evidence[1], evidence[1])
        self.assertEqual(audit['counterCoverageAreas'], {'1': 1.0}, 'input evidence is immutable')
        broken = moved.copy(); broken[34:37, 49:51] = 255
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_COUNTER_LOST'):
            semantic.verify_topology(broken, dict(moved_audit), moved_evidence)
        missing_source_anchor = moved.copy(); missing_source_anchor[15, 15] = 0
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_OBJECT_MISSING'):
            semantic.verify_topology(missing_source_anchor, dict(moved_audit), moved_evidence)

    def test_shared_deformation_cannot_drop_a_counter_outside_the_frame(self):
        source, proposal = self.fixture(material=False)
        _, audit, evidence = semantic.prepare_topology(source, proposal, self.guide('preserve'))
        y, x = np.indices(np.asarray(proposal).shape, dtype=np.float32)
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_COUNTER_LOST'):
            semantic.transport_counter_evidence(audit, evidence, (x+160, y))

    def test_binary_and_subpixel_matches_cannot_reuse_the_same_merged_counter(self):
        values = np.zeros((50, 50), np.uint8)
        values[10:40, 10:40] = 255
        values[25, [25, 27]] = 0
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'plate', 'point': [15, 15]}],
                 'holes': [{'id': i, 'treatment': 'preserve', 'reason': 'distinct source pinhole'}
                           for i in (1, 2)]}
        _, audit, evidence = semantic.prepare_topology(
            Image.new('RGB', (50, 50), 'white'), Image.fromarray(values), guide)
        merged = values.copy(); merged[25, 25:28] = [100, 220, 240]
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_COUNTER_LOST'):
            semantic.verify_topology(merged, audit, evidence)

    def test_an_object_removed_by_final_selection_is_not_certified_complete(self):
        source, proposal = self.fixture(material=False)
        scope = np.full((100,160), 255, np.uint8)
        scope[55:65,40:50] = 0
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_OBJECT_MISSING'):
            matting.refine_source_matte(source, proposal, 'text', scope=Image.fromarray(scope), semantic_topology=self.guide('preserve'))

    def test_material_correction_cannot_overwrite_native_transparency(self):
        source, proposal = self.fixture()
        source = source.convert('RGBA')
        source.putpixel((75,47), (100,75,80,0))
        with self.assertRaisesRegex(ValueError, 'SEMANTIC_REPAIR_SOURCE_TRANSPARENCY'):
            matting.refine_source_matte(source, proposal, 'text', semantic_topology=self.guide())

    def test_topology_preview_uses_registered_hole_positions_like_the_final_renderer(self):
        import cv2
        inspect = module('inspect-v2-matte').inspect
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, proposal = self.fixture()
            source.save(root/'crop.png')
            Image.fromarray(cv2.warpAffine(np.asarray(proposal),
                np.float32([[1,0,12],[0,1,-12]]), proposal.size)).save(root/'raw.png')
            manifest = {'route': 'extract_mask', 'maskProvider': 'imagegen_matte',
                'selectedCropPath': str(root/'crop.png'),
                'envelope': {'attemptId': 'test', 'sourceFingerprint': 'source'},
                'snapshot': {'bounds': {'x':10,'y':20,'width':160,'height':100}, 'paths':[]}}
            (root/'manifest.json').write_text(json.dumps(manifest))
            initial = inspect(root/'manifest.json', root/'raw.png')
            self.assertEqual(initial['holes'][0]['bounds'], {'x':60,'y':43,'width':35,'height':8},
                             'source inspection must not classify a hole at its displaced raw location')
            report = {**manifest['envelope'], 'rawSha256':hashlib.sha256((root/'raw.png').read_bytes()).hexdigest(),
                      'semanticTopology': self.guide()}
            (root/'report.json').write_text(json.dumps(report))
            inspect(root/'manifest.json', root/'raw.png', root/'report.json', root/'preview.png')
            result = Image.open(root/'preview.png')
            self.assertEqual(result.getpixel((135,25))[3], 0)
            self.assertEqual(result.getpixel((75,47))[3], 255)

    def test_inspection_lists_source_bound_holes_and_can_preview_without_finalizing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, proposal = self.fixture()
            source.save(root/'crop.png'); proposal.save(root/'raw.png')
            manifest = {'schemaVersion': 2, 'route': 'extract_mask', 'maskProvider': 'imagegen_matte',
                        'removeBackground': True, 'outputRoot': str(root),
                        'envelope': {'attemptId': 'test', 'sourceFingerprint': 'source'},
                        'selectedCropPath': str(root/'crop.png'),
                        'snapshot': {'processingCategory': 'text', 'bounds': {'x': 10, 'y': 20, 'width': 160, 'height': 100}, 'paths': []}}
            (root/'manifest.json').write_text(json.dumps(manifest))
            command = [sys.executable, str(Path(__file__).with_name('inspect-v2-matte.py')),
                       '--manifest', str(root/'manifest.json'), '--raw', str(root/'raw.png')]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            inspection = json.loads(result.stdout)
            self.assertEqual(inspection['holes'][0]['bounds'], {'x': 60, 'y': 43, 'width': 35, 'height': 8})
            self.assertEqual(inspection['rawSha256'], hashlib.sha256((root/'raw.png').read_bytes()).hexdigest())
            report = {**manifest['envelope'], 'rawSha256': inspection['rawSha256'], 'semanticTopology': self.guide()}
            (root/'review.json').write_text(json.dumps(report))
            preview = root/'preview.png'
            result = subprocess.run(command + ['--report', str(root/'review.json'), '--preview', str(preview)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Image.open(preview).getpixel((75,47)), (*source.getpixel((75,47)), 255))
            self.assertFalse((root/'candidates').exists())
            original = preview.read_bytes()
            result = subprocess.run(command + ['--report', str(root/'review.json'), '--preview', str(preview)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(preview.read_bytes(), original)
            final = root/'processed-preview.png'
            result = subprocess.run(command + ['--report', str(root/'review.json'), '--preview', str(final), '--stage', 'final'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            audit = json.loads(result.stdout)['pixelAudit']
            self.assertEqual(audit['sourceGeometryAlignment']['status'], 'passed')
            self.assertEqual(json.loads(result.stdout)['rgbaSha256'], hashlib.sha256(Image.open(final).tobytes()).hexdigest())
            manifest['semanticTopology'] = self.guide()
            (root/'render-manifest.json').write_text(json.dumps(manifest))
            rendered = root/'delivered.png'
            actual = subprocess.run([sys.executable, str(Path(__file__).with_name('v2-region-pixels.py')),
                '--manifest', str(root/'render-manifest.json'), '--raw', str(root/'raw.png'), '--output', str(rendered)], capture_output=True, text=True)
            self.assertEqual(actual.returncode, 0, actual.stderr)
            self.assertEqual(final.read_bytes(), rendered.read_bytes(), 'inspection and delivery must not use different pixel pipelines')
            self.assertFalse((root/'candidates').exists())


if __name__ == '__main__':
    unittest.main()
