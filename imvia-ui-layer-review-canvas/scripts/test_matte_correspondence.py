"""Source-only geometric correspondences; truth is never supplied to the matcher."""
import importlib.util
from pathlib import Path
import unittest
import json
import shutil
import subprocess
import tempfile
from unittest.mock import patch

import cv2
import numpy as np
from scipy import ndimage as nd
from PIL import Image

spec = importlib.util.spec_from_file_location('correspondence', Path(__file__).with_name('matte-correspondence.py'))
correspondence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(correspondence)


def fixture(width):
    alpha = np.zeros((240, 320), np.uint8)
    cv2.ellipse(alpha, (160, 115), (100, 72), 0, 0, 360, 255, width)
    cv2.line(alpha, (60, 115), (260, 115), 255, width)
    cv2.line(alpha, (160, 43), (160, 115), 255, width)
    cv2.line(alpha, (160, 187), (205, 215), 255, width)
    cv2.circle(alpha, (292, 204), 4, 255, -1)
    y, x = np.indices(alpha.shape, dtype=float)
    foreground = np.broadcast_to([80, 100, 140], (*alpha.shape, 3))
    background = np.dstack((190+x*.06, 190+y*.05, 190+x*.03-y*.02))
    rgb = np.rint(alpha[..., None]/255*foreground+(1-alpha[..., None]/255)*background).astype(np.uint8)
    field = np.stack((5*np.sin(y/65)*np.sin(x/80), 4*np.cos(x/90)*np.sin(y/65)), axis=-1).astype(np.float32)
    # Independent inverse map; the desired alpha remains the original fixture.
    ix, iy = x.astype(np.float32), y.astype(np.float32)
    for _ in range(24):
        dx = cv2.remap(field[..., 0], ix, iy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        dy = cv2.remap(field[..., 1], ix, iy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        ix, iy = (x-dx).astype(np.float32), (y-dy).astype(np.float32)
    moved = cv2.remap(alpha, ix, iy, cv2.INTER_LINEAR)
    return rgb, alpha, moved


def topology(alpha):
    visible = alpha >= 128
    return nd.label(visible)[1], nd.label(nd.binary_fill_holes(visible) & ~visible)[1]


def material_fixture():
    rgb, truth, moved = fixture(3)
    y, x = np.indices(truth.shape)
    foreground = np.dstack((90+25*np.sin(x/15), 120+15*np.cos(y/17), 70+30*np.sin((x+y)/20)))
    background = np.dstack((190+x*.06, 190+y*.05, 190+x*.03-y*.02))
    rgb = np.rint(truth[..., None]/255*foreground+(1-truth[..., None]/255)*background).astype(np.uint8)
    guide = {'version': 1, 'coordinateSpace': 'selected_region_pixels', 'profile': 'material_composite',
             'objects': [{'name': 'connected ring', 'point': [160, 115]},
                         {'name': 'coin', 'point': [292, 204]}],
             'holes': [{'id': i, 'treatment': 'preserve', 'reason': 'visible source background'}
                       for i in range(1, 4)]}
    return rgb, truth, moved, guide


class MatteCorrespondenceTests(unittest.TestCase):
    def test_transport_audit_checks_the_same_map_not_unwarped_binary_component_count(self):
        alpha=np.zeros((35,45),np.uint8)
        alpha[8:26,8:16]=255;alpha[8:26,19:27]=255;alpha[16,16:19]=135
        y,x=np.indices(alpha.shape,dtype=np.float32);mapping=(x+.5,y+.5)
        expected=cv2.remap(alpha,*mapping,cv2.INTER_LINEAR)
        self.assertNotEqual(topology(alpha)[0],topology(expected)[0])
        validate=getattr(correspondence,'alpha_transport_integrity',lambda *a,**k:{'status':'missing'})
        self.assertEqual(validate(alpha,expected,mapping)['status'],'passed')
        broken=expected.copy();broken[:,11:13]=0
        self.assertNotEqual(validate(alpha,broken,mapping)['status'],'passed')
        invented=expected.copy();invented[30:33,35:38]=255
        self.assertNotEqual(validate(alpha,invented,mapping)['status'],'passed')

    def test_registered_material_constraints_stay_in_source_coordinates(self):
        spec=importlib.util.spec_from_file_location('source',Path(__file__).with_name('source-guided-matte.py'))
        source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
        alpha=np.zeros((80,100),np.uint8);alpha[15:65,20:80]=255
        alpha[30:36,30:36]=0;alpha[43:50,60:67]=0
        rgb=np.full((80,100,3),220,np.uint8);rgb[15:65,20:80]=[80,110,140]
        rgb[43:50,60:67]=220
        guide={'version':1,'coordinateSpace':'selected_region_pixels','profile':'material_composite',
               'objects':[{'name':'solid body','point':[50,50]}],
               'holes':[{'id':1,'treatment':'fill_material','reason':'solid source body'},
                        {'id':2,'treatment':'preserve','reason':'visible source background'}]}
        image=Image.fromarray(rgb)
        corrected,_,semantic,audit,evidence=source.prepare_registered_matte(image,Image.fromarray(alpha),semantic_topology=guide)
        moved=np.asarray(corrected).copy();moved[31,31]=0
        y,x=np.indices(alpha.shape,dtype=np.float32)
        with patch.object(source,'coupled_source_deformation',return_value=(moved,{'applied':True},(x,y))):
            result=source.source_joint_registration(image,corrected,np.ones(alpha.shape,bool),semantic,audit,evidence,coupled=True)
        self.assertIsNotNone(result,'source-confirmed material is a fixed constraint, not a generated-mask point')
        value=np.asarray(result[0])
        self.assertEqual(value[31,31],255)
        self.assertEqual(value[46,63],0,'a real source counter must not be filled')
        self.assertEqual(result[1]['status'],'passed')

    def test_one_local_fold_does_not_slow_safe_motion_in_a_different_region(self):
        y,x=np.indices((120,180),dtype=np.float32)
        alpha=np.zeros((120,180),np.uint8);alpha[30:90,30:150]=255
        total=np.zeros((120,180,2),np.float32)
        increment=total.copy();increment[...,0]=3
        increment[...,0]+=-1.8*(x-55)*np.exp(-((x-55)**2+(y-55)**2)/70)
        field,audit=correspondence.bounded_field_update(total,increment,alpha,20)
        self.assertIsNotNone(field)
        self.assertGreater(float(field[60,140,0]),2.9)
        self.assertLess(audit['maximumGradientNorm'],.75)
        self.assertGreaterEqual(audit['minimumJacobian'],.35)

    def test_paired_contour_observations_move_a_thin_ring_as_one_shape(self):
        spec=importlib.util.spec_from_file_location('source',Path(__file__).with_name('source-guided-matte.py'))
        source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
        truth=np.zeros((150,200),np.uint8)
        cv2.ellipse(truth,(100,75),(60,40),0,0,360,255,3)
        y,x=np.indices(truth.shape,dtype=float)
        rgb=np.repeat((200+x*.05+y*.04)[...,None],3,axis=2)
        rgb[truth>0]=[80,120,150]
        proposal=np.roll(truth,4,axis=1)
        result,stats,_=source.coupled_source_deformation(rgb,proposal,radius=8)
        self.assertTrue(stats['applied'])
        a,b=result>=128,truth>=128
        self.assertGreater(np.count_nonzero(a&b)/np.count_nonzero(a|b),.95)
        self.assertEqual(topology(result),topology(truth))

    def test_oversized_increment_can_take_a_safe_shared_step_without_folding(self):
        # Damping one shared field keeps both edges and holes in one coordinate
        # transform. Accepting the full field would fold it (Jacobian -0.2).
        shape=(100,100)
        _,x=np.indices(shape,dtype=np.float32)
        alpha=np.zeros(shape,np.uint8);alpha[20:80,20:80]=255
        total=np.zeros((*shape,2),np.float32)
        increment=total.copy();increment[...,0]=-1.2*(x-50)
        update=getattr(correspondence,'bounded_field_update',lambda *args:(None,{}))
        field,stats=update(total,increment,alpha,100)
        self.assertIsNotNone(field,'an oversized increment must be reduced, not discard all supported motion')
        self.assertEqual(stats['stepScale'],.5)
        np.testing.assert_allclose(field,increment*.5,atol=1e-6)
        self.assertGreaterEqual(stats['minimumJacobian'],.35)
        self.assertLess(stats['maximumGradientNorm'],.75)

    def test_backtracking_does_not_allow_any_active_source_pixel_to_leave_canvas(self):
        alpha=np.zeros((30,30),np.uint8);alpha[0:5,0:5]=255
        total=np.zeros((30,30,2),np.float32)
        increment=np.full_like(total,-1)
        update=getattr(correspondence,'bounded_field_update',lambda *args:(None,{}))
        result,_=update(total,increment,alpha,8)
        self.assertIsNone(result)

    def test_public_renderer_recovers_locally_shifted_material_without_losing_topology(self):
        spec = importlib.util.spec_from_file_location('source', Path(__file__).with_name('source-guided-matte.py'))
        source = importlib.util.module_from_spec(spec); spec.loader.exec_module(source)
        rgb, truth, moved, guide = material_fixture()
        restored, audit, colors = source.refine_source_matte(Image.fromarray(rgb), Image.fromarray(moved),
            'brand_ui', semantic_topology=guide, recover_foreground=True)
        restored = np.asarray(restored)
        self.assertEqual(audit['status'], 'passed', audit)
        self.assertEqual(audit['semanticTopology']['status'], 'passed', audit)
        a, b = restored >= 128, truth >= 128
        self.assertGreater(np.count_nonzero(a & b)/np.count_nonzero(a | b), .985)
        self.assertEqual(topology(restored), topology(truth))
        np.testing.assert_array_equal(np.asarray(colors)[restored == 255], rgb[restored == 255])

    @unittest.skipUnless(shutil.which('node'), 'Node required for actual PNG/PSD codec check')
    def test_joint_registration_preserves_png_psd_pixels_and_source_placement(self):
        spec = importlib.util.spec_from_file_location('pixels', Path(__file__).with_name('v2-region-pixels.py'))
        pixels = importlib.util.module_from_spec(spec); spec.loader.exec_module(pixels)
        rgb, truth, moved, guide = material_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            Image.fromarray(rgb).save(root/'source.png')
            Image.fromarray(moved).save(root/'mask.png')
            manifest = {'schemaVersion': 2, 'route': 'extract_mask', 'maskProvider': 'imagegen_matte',
                        'removeBackground': True, 'outputRoot': str(root), 'semanticTopology': guide,
                        'selectedCropPath': str(root/'source.png'), 'semanticRequirements': {'version': 1},
                        'snapshot': {'processingCategory': 'brand_ui', 'paths': [],
                            'bounds': {'x': 37, 'y': 91, 'width': 320, 'height': 240},
                            'strategy': {'repairPaths': []}}}
            result, audit = pixels.render_region(manifest, root/'mask.png')
            self.assertEqual(audit['status'], 'candidate', audit)
            self.assertEqual(audit['sourceGeometryAlignment']['localContourRepair']['method'], 'joint_source_registration')
            rgba = np.asarray(result)
            np.testing.assert_array_equal(rgba[rgba[..., 3] == 255, :3], rgb[rgba[..., 3] == 255])
            a, b = rgba[..., 3] >= 128, truth >= 128
            self.assertGreater(np.count_nonzero(a & b)/np.count_nonzero(a | b), .985)
            result.save(root/'result.png')
            (root/'audit.json').write_text(json.dumps(audit))
            script = """
                import assert from 'node:assert/strict';
                import {readFile} from 'node:fs/promises';
                import {sourceGeometryMatches} from './src/v2/candidate-review.js';
                import {readPosterPngBytes} from './src/poster-png.js';
                import {composeNormal} from './src/v2/pixels.js';
                import {encodePsd,inspectPsd} from './src/v2/psd-codec.mjs';
                const [pngPath,auditPath]=process.argv.slice(1);
                const audit=JSON.parse(await readFile(auditPath,'utf8'));
                const candidate={pixelAudit:audit,alpha:audit.alpha,semanticRequirements:{version:1},
                    review:{provider:'imagegen_matte',visualReview:{status:'passed'}}};
                assert.equal(sourceGeometryMatches({processingCategory:'brand_ui',strategy:{removeBackground:true}},candidate),true);
                const png=readPosterPngBytes(await readFile(pngPath));
                const image={width:png.width,height:png.height,data:new Uint8ClampedArray(png.pixels)};
                const layers=[{name:'joint-registration independent fixture',image,placement:audit.placement}];
                const composite=composeNormal({width:480,height:400,layers});
                const psd=inspectPsd(encodePsd({width:480,height:400,layers,composite,availableMemory:8*1024**3}),{availableMemory:8*1024**3});
                assert.deepEqual(psd.layers[0].placement,{x:37,y:91});
                assert.ok(Buffer.from(psd.layers[0].image.data).equals(Buffer.from(image.data)));
            """
            checked = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script,
                str(root/'result.png'), str(root/'audit.json')], cwd=Path(__file__).resolve().parents[1],
                text=True, capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_joint_local_registration_preserves_thin_lines_connections_and_holes(self):
        for width in (2, 3, 5, 7):
            with self.subTest(width=width):
                rgb, truth, moved = fixture(width)
                restored, audit = correspondence.register_source_deformation(rgb, moved)
                a, b = restored >= 128, truth >= 128
                iou = np.count_nonzero(a & b)/np.count_nonzero(a | b)
                self.assertGreater(iou, .985, (width, iou, audit))
                self.assertEqual(topology(restored), topology(truth))

    def test_no_source_evidence_does_not_move_the_matte(self):
        _, _, moved = fixture(3)
        rgb = np.full((*moved.shape, 3), 190, np.uint8)
        result, audit = correspondence.register_source_deformation(rgb, moved)
        np.testing.assert_array_equal(result, moved)
        self.assertFalse(audit['applied'])


if __name__ == '__main__':
    unittest.main()
