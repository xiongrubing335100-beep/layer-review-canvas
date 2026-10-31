"""A material notch is not a transparent gap; source pixels are the oracle."""
import importlib.util
from pathlib import Path
import unittest
import json
import hashlib
import cv2
import numpy as np
from scipy import ndimage as nd
from PIL import Image


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class SourceLocalMatteTests(unittest.TestCase):
    def test_black_cleanup_retains_connected_antialias_coverage(self):
        alpha=np.zeros((100,120),np.uint8);alpha[25:75,30:90]=255
        alpha[25:75,29]=6;alpha[25:75,28]=1
        rgb=np.rint(alpha[...,None]/255*np.array([60,90,120])
                    +(1-alpha[...,None]/255)*np.array([240,220,180])).astype(np.uint8)
        proposal=alpha.copy();proposal[0,10:20]=1
        result,audit,_,_,_=module('source-guided-matte').prepare_registered_matte(
            Image.fromarray(rgb),Image.fromarray(proposal))
        np.testing.assert_array_equal(np.asarray(result),alpha)
        self.assertEqual(audit['removedBackgroundNoisePixels'],10)

    def test_remote_black_background_noise_does_not_block_local_registration(self):
        from test_matte_correspondence import material_fixture
        rgb, truth, proposal, guide = material_fixture()
        proposal[0,:] = 1
        proposal[-1,:] = 1
        proposal[:,0] = 1
        proposal[:,-1] = 1
        alpha,audit,_=module('source-guided-matte').refine_source_matte(
            Image.fromarray(rgb),Image.fromarray(proposal),'brand_ui',
            semantic_topology=guide,recover_foreground=True)
        actual=np.asarray(alpha)>=128; expected=truth>=128
        iou=np.count_nonzero(actual&expected)/np.count_nonzero(actual|expected)
        self.assertGreater(iou,.985,(iou,audit))
        self.assertEqual(audit['status'],'passed',audit)

    def notch_fixture(self):
        alpha = np.zeros((80,100),np.uint8)
        alpha[15:65,20:80]=255; alpha[28:34,20:39]=0
        guide={'version':1,'coordinateSpace':'selected_region_pixels','profile':'material_composite',
               'objects':[{'name':'solid body','point':[50,50]}],'holes':[],
               'materialNotches':[{'id':1,'reason':'Source-inspected opaque material.'}]}
        return Image.new('RGBA',(100,80),(170,110,30,255)),Image.fromarray(alpha),guide

    def test_notch_correction_does_not_cross_selection_or_source_transparency(self):
        semantic=module('semantic-matte')
        source,alpha,guide=self.notch_fixture()
        scope=np.full((80,100),255,np.uint8);scope[30,30]=0
        with self.assertRaisesRegex(ValueError,'SEMANTIC_REPAIR_OUTSIDE_SELECTION'):
            semantic.prepare_topology(source,alpha,guide,Image.fromarray(scope))
        source.putpixel((30,30),(170,110,30,0))
        with self.assertRaisesRegex(ValueError,'SEMANTIC_REPAIR_SOURCE_TRANSPARENCY'):
            semantic.prepare_topology(source,alpha,guide)

    def test_undeclared_notch_is_not_filled_and_bad_ids_cannot_select_another_region(self):
        semantic=module('semantic-matte')
        source,alpha,guide=self.notch_fixture()
        undeclared={**guide,'materialNotches':[]}
        result,_,_=semantic.prepare_topology(source,alpha,undeclared)
        self.assertEqual(result.getpixel((30,30)),0)
        for decisions in ([{'id':100,'reason':'wrong ID'}],guide['materialNotches']*2):
            with self.assertRaisesRegex(ValueError,'SEMANTIC_NOTCH_'):
                semantic.prepare_topology(source,alpha,{**guide,'materialNotches':decisions})

    def test_source_confirmed_open_material_notch_is_not_treated_as_background(self):
        alpha = np.zeros((80, 100), np.uint8)
        alpha[15:65, 20:80] = 255
        alpha[28:34, 20:39] = 0  # Open, unlike an enclosed counter.
        source = Image.new('RGB', (100,80), (220,210,190))
        rgb = np.asarray(source).copy(); rgb[15:65,20:80] = [170,110,30]
        rgb[28:34,20:39] = [40,30,20]  # An opaque dark grille.
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite', 'objects': [{'name':'solid body','point':[50,50]}],
                 'holes': [], 'materialNotches': [{'id': 1, 'reason':'Opaque dark grille on source body.'}]}
        corrected, audit, evidence = module('semantic-matte').prepare_topology(
            Image.fromarray(rgb), Image.fromarray(alpha), guide)
        self.assertEqual(corrected.getpixel((30,30)),255)
        self.assertEqual(corrected.getpixel((10,30)),0)
        self.assertEqual(audit['restoredNotchIds'],[1])

    def test_solid_grille_notches_are_repaired_without_losing_ring_or_counter(self):
        h, w = 280, 320
        yy, xx = np.indices((h, w))
        truth = np.zeros((h, w), np.uint8)
        cv2.ellipse(truth, (160, 143), (107, 90), 0, 0, 360, 255, 4)
        cv2.ellipse(truth, (160, 100), (42, 62), 0, 0, 360, 255, -1)
        cv2.rectangle(truth, (80, 150), (240, 240), 255, -1)
        cv2.circle(truth, (160, 200), 15, 0, -1)
        # Locally varying metal and background share some colors. Dark bands
        # end at the true exterior, not at the proposal's invented notches.
        rgb = np.dstack((225+5*np.sin(xx/30), 215+yy*.03, 190+xx*.03))
        metal = np.dstack((210+30*np.cos(xx/8), 150+40*np.cos(xx/12), 75+50*np.sin(yy/15)))
        rgb[truth > 0] = metal[truth > 0]
        for y in (75, 90, 105):
            rgb[y:y+5][truth[y:y+5] > 0] = [55, 38, 15]
        rgb = np.uint8(np.clip(rgb, 0, 255))
        proposal = truth.copy()
        proposal[26:45, 145:175] = 255
        for y in (75, 90, 105):
            proposal[y:y+5, 118:130] = 0
            proposal[y:y+5, 190:203] = 0
        semantic = module('semantic-matte')
        _, holes = semantic.hole_components(Image.fromarray(proposal))
        guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels',
                 'profile': 'material_composite',
                 'objects': [{'name': 'opaque body', 'point': [160, 125]},
                             {'name': 'thin ring', 'point': [53, 143]}],
                 'holes': [{'id': item['id'], 'treatment': 'preserve',
                            'reason': 'Source background visible through ring and body counter.'}
                           for item in holes]}
        alpha, audit, colors = module('source-guided-matte').refine_source_matte(
            Image.fromarray(rgb), Image.fromarray(proposal), 'brand_ui',
            semantic_topology=guide, recover_foreground=True)
        actual = np.asarray(alpha)
        expected = truth > 0
        iou = np.count_nonzero((actual >= 128) & expected)/np.count_nonzero((actual >= 128) | expected)
        self.assertGreater(iou, .99, (iou, audit))
        self.assertTrue(np.all(actual[91:94, 120:129] == 255), 'solid dark grille must stay opaque')
        self.assertEqual(int(actual[30, 160]), 0, 'background above head must not remain')
        self.assertEqual(int(actual[200, 160]), 0, 'true counter must remain transparent')
        self.assertEqual(nd.label(actual >= 128)[1], 1, 'thin ring must stay connected')
        np.testing.assert_array_equal(np.asarray(colors)[actual == 255], rgb[actual == 255])


class RealAssemblyRegression(unittest.TestCase):
    def test_previously_verified_ui_result_remains_pixel_stable(self):
        root=Path(__file__).resolve().parents[1]/'output/acceptance-ui-local-replay-20261015/attempts/82f4eeabb596bade42469af9fb9f99f0'
        if not root.exists():
            self.skipTest('original UI acceptance evidence unavailable')
        manifest=json.loads((root/'manifest.json').read_text())
        report=json.loads((root/'review.json').read_text())
        image,audit=module('v2-region-pixels').render_region(
            {**manifest,'semanticTopology':report['semanticTopology']},root/'raw.png')
        self.assertEqual(audit['status'],'candidate',audit)
        self.assertEqual(hashlib.sha256(image.tobytes()).hexdigest(),report['finalPreview']['rgbaSha256'])

    def test_original_task_excludes_architecture_above_the_microphone(self):
        root = Path(__file__).resolve().parents[1]/'output/acceptance-composite-20261014/attempts/3ab6999a79e7dcf0c9d2e5b04a345cf4'
        if not root.exists():
            self.skipTest('original acceptance evidence unavailable')
        manifest = json.loads((root/'manifest.json').read_text())
        # The frozen historical report predates source-inspected open material
        # notches. Use the current inspection, bound to the SAME untouched raw
        # and source, as a normal new V2 execution does. Never rewrite history.
        report = json.loads((Path(__file__).with_name('fixtures')/'original-assembly-semantic-review.json').read_text())
        self.assertEqual(hashlib.sha256((root/'raw.png').read_bytes()).hexdigest(),report['rawSha256'])
        self.assertEqual(manifest['envelope']['sourceFingerprint'],report['sourceFingerprint'])
        image, audit = module('v2-region-pixels').render_region(
            {**manifest, 'semanticTopology': report['semanticTopology']}, root/'raw.png')
        self.assertLessEqual(image.getpixel((580, 38))[3], 8,
                             'source architecture is 10px above the actual microphone')
        self.assertEqual(image.getpixel((578, 292)), Image.open(root/'selected-crop.png').convert('RGBA').getpixel((578, 292)))
        self.assertEqual(audit['status'],'candidate',audit)
        self.assertEqual(audit['semanticTopology']['status'],'passed',audit)
        rgba=np.asarray(image);source=np.asarray(Image.open(root/'selected-crop.png').convert('RGBA'))
        np.testing.assert_array_equal(rgba[rgba[...,3]==255,:3],source[rgba[...,3]==255,:3])


if __name__ == '__main__':
    unittest.main()
