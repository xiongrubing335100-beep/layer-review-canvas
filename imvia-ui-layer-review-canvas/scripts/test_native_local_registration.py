import importlib.util
from pathlib import Path
import unittest
import numpy as np

class LocalRegistrationTests(unittest.TestCase):
    def module(self):
        filename=Path(__file__).with_name('native-local-registration.py')
        self.assertTrue(filename.exists(), 'source-evidenced local registration is not implemented')
        spec=importlib.util.spec_from_file_location('local_registration',filename)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def points(self):
        yy,xx=np.mgrid[40:440:25,40:600:25]
        return np.stack([xx.ravel(),yy.ravel()],axis=1).astype(float)

    def test_corrects_different_upper_lower_displacements_without_global_offset(self):
        module=self.module();q=self.points()
        p=q+np.stack([6*np.sin(q[:,1]/150),9*np.cos(q[:,1]/200)],axis=1)
        transform,audit=module.fit_local_map(p,q,(640,480))
        probes=np.array([[100,100],[300,240],[500,380]],float)
        expected=probes+np.stack([6*np.sin(probes[:,1]/150),9*np.cos(probes[:,1]/200)],axis=1)
        np.testing.assert_allclose(module.map_points(transform,probes),expected,atol=.7)
        self.assertLessEqual(audit['holdoutP95SourcePixels'],3)
        self.assertGreater(audit['minimumRelativeJacobian'],.5)

    def test_random_correspondences_cannot_supply_local_geometry(self):
        module=self.module();q=self.points();rng=np.random.default_rng(71)
        with self.assertRaisesRegex(ValueError,'NATIVE_LOCAL_'):
            module.fit_local_map(q[rng.permutation(len(q))],q,(640,480))

    def test_one_small_patch_cannot_align_entire_subject(self):
        module=self.module();q=self.points()*.1
        with self.assertRaisesRegex(ValueError,'NATIVE_LOCAL_'):
            module.fit_local_map(q+[8,3],q,(640,480))

    def test_large_local_deformation_is_not_accepted(self):
        module=self.module();q=self.points()
        p=q+np.stack([70*np.sin(q[:,1]/80),np.zeros(len(q))],axis=1)
        with self.assertRaisesRegex(ValueError,'NATIVE_LOCAL_'):
            module.fit_local_map(p,q,(640,480))

    def test_large_renderer_strip_does_not_exceed_opencv_axis_limit(self):
        module=self.module()
        yy,xx=np.mgrid[:64,:1200]
        points=np.stack([xx,yy],axis=-1).astype(np.float32)
        transform={'inverse':np.array([[1.,0,0],[0,1.,0]]),
            'delta':np.zeros((9,151,2),np.float32),'size':(1200,64),'scale':1.}
        np.testing.assert_array_equal(module.map_points(transform,points),points)

if __name__=='__main__': unittest.main()
