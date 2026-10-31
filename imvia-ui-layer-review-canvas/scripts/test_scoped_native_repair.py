import importlib.util
from pathlib import Path
import unittest
import numpy as np
from PIL import Image

class ScopedRepairTests(unittest.TestCase):
    def merger(self):
        path=Path(__file__).with_name('scoped-native-repair.py')
        self.assertTrue(path.exists(), 'bounded RGBA merger must exist')
        spec=importlib.util.spec_from_file_location('scoped',path)
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module.merge_scoped_repair

    def test_hole_and_thin_line_change_only_within_diagnosed_bounds(self):
        merge=self.merger()
        first=np.full((12,16,4),(90,80,70,255),dtype=np.uint8)
        repaired=np.full_like(first,(200,190,180,0))
        # A transparent hole plus a one-pixel solid bridge, while model changed everything.
        repaired[5,4:8]=(90,80,70,255)
        defects=[dict(x=4,y=3,width=4,height=4)]
        result,audit=merge(Image.fromarray(first),Image.fromarray(repaired),defects,Image.new('L',(16,12),255))
        actual=np.array(result)
        self.assertEqual(actual[3,4,3],0)
        self.assertEqual(actual[5,5,3],255)
        self.assertTrue(np.array_equal(actual[:3],first[:3]))
        self.assertTrue(np.array_equal(actual[:,8:],first[:,8:]))
        self.assertTrue(audit['outsideScopeRgbaIdentical'])
        self.assertEqual(audit['changedAlphaPixels'],12)

    def test_excluded_pixels_and_partial_path_coverage_are_not_changed(self):
        merge=self.merger()
        first=Image.new('RGBA',(8,8),(20,30,40,255)); repaired=Image.new('RGBA',(8,8),(60,70,80,0))
        permission=np.full((8,8),255,dtype=np.uint8); permission[2,2]=0; permission[2,3]=128
        result,_=merge(first,repaired,[dict(x=1,y=1,width=3,height=3)],Image.fromarray(permission))
        self.assertEqual(result.getpixel((2,2)),(20,30,40,255))
        self.assertEqual(result.getpixel((3,2)),(20,30,40,255))
        self.assertEqual(result.getpixel((1,1)),(60,70,80,0))

    def test_invalid_scope_and_wrong_sizes_rejected(self):
        merge=self.merger(); first=Image.new('RGBA',(8,8)); permission=Image.new('L',(8,8),255)
        for defects in [[],[dict(x=-1,y=0,width=2,height=2)],[dict(x=0,y=0,width=8,height=8)]]:
            with self.assertRaisesRegex(ValueError,'REPAIR_'):
                merge(first,first,defects,permission)
        with self.assertRaisesRegex(ValueError,'REPAIR_'):
            merge(first,Image.new('RGBA',(9,8)),[dict(x=1,y=1,width=2,height=2)],permission)

    def test_source_supported_merge_fixes_notch_without_replacing_good_edge(self):
        source = np.full((100, 120, 3), 20, np.uint8)
        source[20:80, 20:100] = (230, 170, 80)
        alpha = np.zeros((100, 120), np.uint8)
        alpha[20:80, 20:100] = 255
        initial = np.dstack((source, alpha))
        initial[38:48, 20:24, 3] = 0
        repair = np.dstack((source, alpha))
        # Corrects left notch but needlessly erodes an already correct bottom.
        repair[76:80, 20:42, 3] = 0
        defects = [dict(kind="missing_edge", x=15, y=30, width=30, height=55)]
        try:
            result, audit = self.merger()(Image.fromarray(initial), Image.fromarray(repair),
                defects, Image.new("L", (120, 100), 255), source=Image.fromarray(source))
        except TypeError as error:
            self.fail(f"Source-aware repair selection is missing: {error}")
        np.testing.assert_array_equal(np.asarray(result), np.dstack((source, alpha)))
        self.assertTrue(audit["outsideScopeRgbaIdentical"])

    def test_source_supported_merge_cannot_remove_an_entire_visible_component(self):
        source = np.full((60, 80, 3), 20, np.uint8)
        source[20:30, 20:30] = 230
        initial = np.dstack((source, np.zeros((60, 80), np.uint8)))
        initial[20:30, 18:28, 3] = 255
        repair = initial.copy()
        repair[..., 3] = 0
        try:
            result, _ = self.merger()(Image.fromarray(initial), Image.fromarray(repair),
                [dict(kind="missing_edge", x=15, y=15, width=20, height=20)],
                Image.new("L", (80, 60), 255), source=Image.fromarray(source))
        except TypeError as error:
            self.fail(f"Source-aware repair selection is missing: {error}")
        np.testing.assert_array_equal(np.asarray(result), initial)

    def test_rgb_adjustment_cannot_join_good_alpha_addition_to_bad_removal(self):
        source = np.full((100, 120, 3), 20, np.uint8)
        source[20:80, 20:100] = (230, 170, 80)
        alpha = np.zeros((100, 120), np.uint8)
        alpha[20:80, 20:100] = 255
        initial = np.dstack((source, alpha))
        initial[38:48, 20:24, 3] = 0
        repair = np.dstack((source, alpha))
        repair[76:80, 20:42, 3] = 0
        # A permissible RGB adjustment connects unrelated matte edits.
        repair[38:80, 20:24, 0] -= 1
        result, audit = self.merger()(Image.fromarray(initial), Image.fromarray(repair),
            [dict(kind="missing_edge", x=15, y=30, width=30, height=55)],
            Image.new("L", (120, 100), 255), source=Image.fromarray(source))
        np.testing.assert_array_equal(np.asarray(result)[..., 3], alpha)
        self.assertTrue(audit["outsideScopeRgbaIdentical"])

    def test_patch_cannot_cut_a_new_step_from_an_improved_long_edge(self):
        source = np.full((100, 120, 3), 20, np.uint8)
        source[20:60, 20:100] = (230, 170, 80)
        alpha = np.zeros((100, 120), np.uint8)
        alpha[20:52, 20:100] = 255
        initial = np.dstack((source, alpha))
        repaired = initial.copy()
        repaired[52:60, 20:100, 3] = 255
        # Both proposals have continuous horizontal edges. Clipping the
        # improved proposal to this patch must not invent vertical steps.
        result, audit = self.merger()(Image.fromarray(initial), Image.fromarray(repaired),
            [dict(kind="missing_edge", x=40, y=45, width=40, height=20)],
            Image.new("L", (120, 100), 255), source=Image.fromarray(source))
        np.testing.assert_array_equal(np.asarray(result), initial)
        self.assertTrue(audit["outsideScopeRgbaIdentical"])

    def test_source_confirmed_corner_at_patch_boundary_is_not_an_artificial_seam(self):
        alpha = np.zeros((100, 120), np.uint8)
        alpha[20:60, 20:60] = 255
        wanted = alpha.copy()
        wanted[40:60, 60:80] = 255
        source = np.full((100, 120, 3), 20, np.uint8)
        source[wanted > 0] = (230, 170, 80)
        initial = np.dstack((source, alpha))
        repaired = initial.copy()
        repaired[20:60, 60:80, 3] = 255
        result, audit = self.merger()(Image.fromarray(initial), Image.fromarray(repaired),
            [dict(kind="missing_edge", x=55, y=40, width=30, height=25)],
            Image.new("L", (120, 100), 255), source=Image.fromarray(source))
        np.testing.assert_array_equal(np.asarray(result)[..., 3], wanted)
        self.assertTrue(audit["outsideScopeRgbaIdentical"])

    def test_smooth_illumination_ramp_does_not_justify_a_new_scope_edge(self):
        spec = importlib.util.spec_from_file_location(
            "seam", Path(__file__).with_name("scoped-native-repair.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        before = np.zeros((100, 120, 4), np.uint8)
        before[20:52, 20:100, 3] = 255
        after = before.copy()
        after[52:60, 20:100, 3] = 255
        scope = np.zeros((100, 120), bool)
        scope[45:65, 40:80] = True
        proposal = before.copy()
        proposal[scope] = after[scope]
        source = np.repeat(np.broadcast_to(np.arange(120, dtype=np.uint8)*2,
                                          (100, 120))[..., None], 3, axis=2)
        self.assertGreater(module.scope_cut_edges(before, after, proposal, scope, source), 0)

if __name__=='__main__': unittest.main()
