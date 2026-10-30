import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location('native_registration', Path(__file__).with_name('native-rgba-registration.py'))
registration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registration)

class NativeRegistrationTests(unittest.TestCase):
    def test_local_map_samples_rgba_together_without_filling_counter(self):
        raw=np.zeros((40,60,4),np.uint8)
        cv2.rectangle(raw,(5,5),(52,32),(220,170,60,255),1)
        transform={'inverse':np.array([[1.,0,0],[0,1.,0]]),
                   'delta':np.zeros((6,9,2),np.float32),'size':(60,40),'scale':1.}
        mapping={'contentRegion':{'x':0,'y':0,'width':60,'height':40}}
        result=registration.sample_aligned(Image.fromarray(raw),transform,mapping,(60,40))
        np.testing.assert_array_equal(np.asarray(result),raw)

    def test_repeated_sparse_marks_cannot_choose_arbitrary_source_instance(self):
        alpha=np.zeros((140,140),np.uint8)
        cv2.ellipse(alpha,(65,72),(37,29),0,0,360,255,6,cv2.LINE_AA)
        cv2.line(alpha,(34,61),(64,83),255,5,cv2.LINE_AA)
        cv2.line(alpha,(64,83),(94,55),255,5,cv2.LINE_AA)
        two=np.concatenate([alpha,alpha],axis=1)
        rgb=np.repeat((30+two.astype(float)*.8).astype(np.uint8)[...,None],3,axis=2)
        crop=Image.fromarray(rgb).convert('RGBA')
        raw=np.full((140,280,4),234,np.uint8)
        raw[...,3]=np.concatenate([alpha,np.zeros_like(alpha)],axis=1)
        mapping={'contentRegion':{'x':0,'y':0,'width':1120,'height':560}}
        with self.assertRaisesRegex(ValueError,'NATIVE_ALIGNMENT'):
            registration.estimate_sparse_alignment(crop.resize((1120,560)),
                Image.fromarray(raw).resize((1120,560)),crop,mapping)

    def test_sparse_emblem_uses_complete_source_contour_evidence(self):
        alpha = np.zeros((140,140),np.uint8)
        cv2.ellipse(alpha,(65,72),(37,29),0,0,360,255,6,cv2.LINE_AA)
        cv2.line(alpha,(34,61),(64,83),255,5,cv2.LINE_AA)
        cv2.line(alpha,(64,83),(94,55),255,5,cv2.LINE_AA)
        rgb = np.repeat((30+alpha.astype(float)*.8).astype(np.uint8)[...,None],3,axis=2)
        crop = Image.fromarray(rgb).convert('RGBA')
        reference = crop.resize((560,560),Image.Resampling.BILINEAR)
        rgba = np.full((140,140,4),234,np.uint8);rgba[...,3]=alpha
        raw = np.asarray(Image.fromarray(rgba).resize((560,560),Image.Resampling.BILINEAR))
        transform=np.array([[1.1,0,-12],[0,1.1,-15]],float)
        raw=cv2.warpAffine(raw,transform,(560,560))
        mapping={'contentRegion':{'x':0,'y':0,'width':560,'height':560}}
        matrix,audit=registration.estimate_alignment(reference,Image.fromarray(raw),source_crop=crop,mapping=mapping)
        np.testing.assert_allclose(matrix,cv2.invertAffineTransform(transform),atol=3)
        self.assertGreaterEqual(audit['sourceContour']['boundaryMatchRatio'],.9)
        self.assertLessEqual(audit['sourceContour']['longestUnsupportedRun'],12)

    def test_enlarged_sparse_emblem_recovers_source_scale_and_counter(self):
        alpha = np.zeros((140,140),np.uint8)
        cv2.ellipse(alpha,(65,72),(37,29),0,0,360,255,6,cv2.LINE_AA)
        cv2.line(alpha,(34,61),(64,83),255,5,cv2.LINE_AA)
        cv2.line(alpha,(64,83),(94,55),255,5,cv2.LINE_AA)
        rgb = np.repeat((30+alpha.astype(float)*.8).astype(np.uint8)[...,None],3,axis=2)
        crop = Image.fromarray(rgb).convert('RGBA')
        reference = crop.resize((560,560),Image.Resampling.BILINEAR)
        rgba = np.full((140,140,4),234,np.uint8)
        rgba[...,3] = alpha
        raw = np.asarray(Image.fromarray(rgba).resize((560,560),Image.Resampling.BILINEAR))
        transform = np.array([[1.6,0,-160],[0,1.6,-170]],float)
        raw = Image.fromarray(cv2.warpAffine(raw,transform,(560,560)))
        mapping = {'contentRegion':{'x':0,'y':0,'width':560,'height':560}}
        matrix,audit = registration.estimate_sparse_alignment(reference,raw,crop,mapping)
        np.testing.assert_allclose(matrix,cv2.invertAffineTransform(transform),atol=3)
        self.assertGreaterEqual(audit['sourceContour']['boundaryMatchRatio'],.9)
        self.assertLessEqual(audit['sourceContour']['longestUnsupportedRun'],12)
        aligned = np.asarray(registration.sample_aligned(raw,matrix,mapping,crop.size))
        self.assertLess(int(aligned[93,65,3]),10, 'the lower counter remains transparent')
        self.assertGreater(int(aligned[72,28,3]),200, 'the original ring remains intact')

    def test_low_contrast_letters_on_uneven_background_keep_alignment(self):
        alpha = np.zeros((512, 768), np.uint8)
        for row, text in enumerate(('AB39pq5', 'xyR027K', 'M8Z416s')):
            cv2.putText(alpha, text, (60, 140 + row*130), cv2.FONT_HERSHEY_COMPLEX,
                        2.5, 255, 5, cv2.LINE_AA)
        y, x = np.mgrid[:512, :768]
        background = 170 + 25*np.sin(x/180) + 12*np.cos(y/120)
        foreground = background + 12
        visible = np.rint(background*(1-alpha/255) + foreground*alpha/255).astype(np.uint8)
        source = np.dstack([visible, visible, visible, np.full_like(alpha,255)])
        raw = np.dstack([foreground, foreground, foreground, alpha]).astype(np.uint8)
        transform = np.array([[1.01, 0, 4], [0, 1.01, -5]], np.float64)
        raw = cv2.warpAffine(raw, transform, (768,512))
        matrix, audit = registration.estimate_alignment(Image.fromarray(source), Image.fromarray(raw))
        np.testing.assert_allclose(matrix, cv2.invertAffineTransform(transform), atol=1)
        self.assertEqual(audit['status'], 'passed')

    def test_hidden_rgb_cannot_destroy_flat_foreground_registration(self):
        alpha = np.zeros((360, 600), np.uint8)
        for row, text in enumerate(('AB39pq5', 'xyR027K', 'M8Z416s')):
            cv2.putText(alpha, text, (35, 90 + row*100), cv2.FONT_HERSHEY_COMPLEX,
                        2, 255, 3, cv2.LINE_AA)
        source = np.zeros((360, 600, 4), np.uint8)
        source[..., :3] = alpha[..., None]
        source[..., 3] = 255
        transform = np.array([[1.02, 0, 8], [0, 1.02, -6]], np.float64)
        generated_alpha = cv2.warpAffine(alpha, transform, (600, 360))
        raw = np.full_like(source, 255)
        raw[..., 3] = generated_alpha
        matrix, audit = registration.estimate_alignment(Image.fromarray(source), Image.fromarray(raw))
        np.testing.assert_allclose(matrix, cv2.invertAffineTransform(transform), atol=.6)
        self.assertEqual(audit['status'], 'passed')
    def test_recovers_global_shift_and_scale_from_content_not_alpha_bounds(self):
        rng = np.random.default_rng(172)
        source = np.zeros((320, 480, 4), np.uint8)
        for _ in range(120):
            x, y = rng.integers([45, 40], [430, 280])
            cv2.circle(source, (int(x), int(y)), int(rng.integers(2, 9)), tuple(map(int, rng.integers(40, 250, 3))) + (255,), -1)
        transform = np.array([[1.07, 0, -10], [0, 1.07, -5]], np.float64)
        raw = cv2.warpAffine(source, transform, (480, 320))
        matrix, audit = registration.estimate_alignment(Image.fromarray(source), Image.fromarray(raw))
        np.testing.assert_allclose(matrix, cv2.invertAffineTransform(transform), atol=.5)
        self.assertEqual(audit['status'], 'passed')

    def test_unrelated_images_cannot_establish_alignment(self):
        with self.assertRaisesRegex(ValueError, 'NATIVE_ALIGNMENT'):
            registration.estimate_alignment(Image.new('RGBA', (100, 100), 'red'), Image.new('RGBA', (100, 100), 'blue'))

    def test_identity_mapping_preserves_thin_alpha_and_holes_exactly(self):
        raw = np.zeros((20, 30, 4), np.uint8)
        cv2.rectangle(raw, (2, 2), (25, 16), (255, 180, 90, 255), 1)
        mapping = {'canvas': {'width': 30, 'height': 20}, 'contentRegion': {'x': 0, 'y': 0, 'width': 30, 'height': 20}}
        result = registration.sample_aligned(Image.fromarray(raw), np.array([[1.,0,0],[0,1.,0]]), mapping, (30,20))
        np.testing.assert_array_equal(np.asarray(result), raw)
