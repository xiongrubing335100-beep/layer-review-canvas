import json
import subprocess
import tempfile
import unittest
import importlib.util
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


SCRIPT = Path(__file__).with_name("v2-region-pixels.py")
SPEC = importlib.util.spec_from_file_location("region_pixels", SCRIPT)
PIXELS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIXELS)


class V2RegionPixelTests(unittest.TestCase):
    def test_scoped_second_pass_repairs_alpha_without_changing_other_pixels(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            source=Image.new('RGBA',(32,32),(60,80,100,255)); source.save(root/'source.png')
            first=source.copy(); first.putpixel((10,10),(60,80,100,0)); first.save(root/'raw.png')
            second=Image.new('RGBA',(32,32),(200,10,20,0)); second.putpixel((10,10),(60,80,100,255)); second.save(root/'repair.png')
            manifest={'schemaVersion':2,'route':'reconstruct','maskProvider':'native_rgba',
                'nativeRgbaRequirements':{'version':3},'rawCoordinateSpace':'selected_region','maximumImagegenCalls':2,
                'removeBackground':True,'outputRoot':temporary,'selectedCropPath':str(root/'source.png'),
                'snapshot':{'bounds':{'x':100,'y':200,'width':32,'height':32},'strategy':{'repairPaths':[],
                    'fidelityPolicy':'source_faithful_repair','localRepairPolicy':'scoped_once_v1'}},
                'scopedNativeRepair':{'version':1,'rawPath':str(root/'repair.png'),
                    'parentRawSha256':hashlib.sha256((root/'raw.png').read_bytes()).hexdigest(),
                    'rawSha256':hashlib.sha256((root/'repair.png').read_bytes()).hexdigest(),
                    'defects':[{'x':10,'y':10,'width':1,'height':1}]}}
            result,audit=PIXELS.render_region(manifest,root/'raw.png')
            self.assertEqual(result.getpixel((10,10)),(60,80,100,255))
            self.assertEqual(result.tobytes(),source.tobytes())
            self.assertTrue(audit['scopedRepair']['outsideScopeRgbaIdentical'])
            self.assertEqual(audit['scopedRepair']['changedAlphaPixels'],1)

    def test_automatic_native_patch_changes_only_mismatched_edge_not_interior(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = Image.new('RGBA', (64, 64), (60, 80, 100, 255))
            raw = Image.new('RGBA', (64, 64), (60, 80, 100, 0))
            ImageDraw.Draw(raw).rectangle((8,8,55,55), fill=(60,80,100,255))
            # Source background leaked into a displaced edge; model repairs it.
            source.putpixel((8,30), (220,210,200,255))
            # Model changed correct interior material: must NOT be used.
            raw.putpixel((30,30), (250,0,0,255))
            source.save(root/'source.png'); raw.save(root/'raw.png')
            manifest = {'schemaVersion':2, 'route':'reconstruct', 'maskProvider':'native_rgba',
                        'nativeRgbaRequirements':{'version':3}, 'rawCoordinateSpace':'selected_region',
                        'removeBackground':True, 'outputRoot':temporary,
                        'selectedCropPath':str(root/'source.png'),
                        'snapshot':{'bounds':{'x':0,'y':0,'width':64,'height':64},
                                    'strategy':{'repairPaths':[]}}}
            result, audit = PIXELS.render_region(manifest, root/'raw.png')
            self.assertEqual(result.getpixel((8,30)), (60,80,100,255))
            self.assertEqual(result.getpixel((30,30)), (60,80,100,255))
            self.assertEqual(result.getchannel('A').tobytes(),raw.getchannel('A').tobytes())
            self.assertTrue(audit['localRepair']['outsideRepairRgbIdentical'])
            self.assertGreater(audit['localRepair']['automaticRepairPixels'],0)
            self.assertLess(audit['localRepair']['changedRgbPixels'], 10)
            # An explicit patch is a user bound: automatic edge repair must not
            # expand it to include the discrepant boundary pixel.
            manifest['snapshot']['strategy']['repairPaths'] = [self.polygon([(29,29),(32,29),(32,32),(29,32)])]
            result, audit = PIXELS.render_region(manifest, root/'raw.png')
            self.assertEqual(result.getpixel((8,30)), source.getpixel((8,30)))
            self.assertEqual(result.getpixel((30,30)), raw.getpixel((30,30)))
            self.assertEqual(audit['localRepair']['automaticRepairPixels'], 0)

    def test_automatic_boundary_mask_does_not_repaint_matching_or_opaque_images(self):
        source = Image.new('RGBA',(48,48),(100,80,60,255))
        self.assertEqual(PIXELS.native_boundary_repair_mask(source,source).getextrema(), (0,0))
        raw = source.copy()
        raw.putpixel((24,24),(0,255,0,255))
        self.assertEqual(PIXELS.native_boundary_repair_mask(source,raw).getextrema(), (0,0))

    def test_local_native_repair_keeps_source_rgb_and_independent_cutout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            Image.new('RGBA', (4, 2), (40, 60, 80, 255)).save(root / 'source.png')
            raw = Image.new('RGBA', (4, 2), (200, 100, 20, 255))
            raw.putpixel((3, 0), (200, 100, 20, 0))
            raw.putpixel((2, 0), (200, 100, 20, 128))
            raw.save(root / 'raw.png')
            manifest = {'schemaVersion': 2, 'route': 'reconstruct', 'maskProvider': 'native_rgba',
                        'nativeRgbaRequirements': {'version': 2},
                        'rawCoordinateSpace': 'selected_region', 'removeBackground': True,
                        'outputRoot': temporary, 'selectedCropPath': str(root / 'source.png'),
                        'snapshot': {'bounds': {'x': 10, 'y': 20, 'width': 4, 'height': 2},
                                     'strategy': {'repairPaths': []}}}
            result, audit = PIXELS.render_region(manifest, root / 'raw.png')
            self.assertEqual(result.getpixel((0, 0)), (40, 60, 80, 255))
            self.assertEqual(result.getpixel((2, 0)), (40, 60, 80, 128))
            self.assertEqual(result.getpixel((3, 0))[3], 0)
            self.assertEqual(audit['localRepair']['changedRgbPixels'], 0)
            manifest['snapshot']['strategy']['repairPaths'] = [self.polygon([(10,20),(11,20),(11,22),(10,22)])]
            result, audit = PIXELS.render_region(manifest, root / 'raw.png')
            self.assertEqual(result.getpixel((0, 0)), (200, 100, 20, 255))
            self.assertEqual(result.getpixel((1, 0)), (40, 60, 80, 255))
            self.assertEqual(result.getpixel((3, 0))[3], 0)
            self.assertEqual(audit['localRepair']['changedRgbPixels'], 2)
            self.assertEqual(audit['localRepair']['outsideRepairRgbIdentical'], True)

    def test_native_rgba_preserves_every_pixel_without_a_second_matte(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = Image.new('RGBA', (8, 8), (40, 30, 20, 255))
            source.save(root / 'source.png')
            raw = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
            draw = ImageDraw.Draw(raw)
            draw.rectangle((1, 1, 6, 6), outline=(230, 180, 90, 255), width=1)
            raw.putpixel((0, 0), (255, 230, 180, 80))
            raw.save(root / 'raw.png')
            manifest = {'schemaVersion': 2, 'route': 'reconstruct', 'maskProvider': 'native_rgba',
                        'rawCoordinateSpace': 'selected_region', 'removeBackground': True,
                        'outputRoot': temporary, 'selectedCropPath': str(root / 'source.png'),
                        'snapshot': {'bounds': {'x': 17, 'y': 29, 'width': 8, 'height': 8},
                                     'strategy': {'repairPaths': []}}}
            result, audit = PIXELS.render_region(manifest, root / 'raw.png')
            self.assertEqual(result.tobytes(), raw.tobytes())
            self.assertEqual(audit['placement'], {'x': 17, 'y': 29})
            self.assertEqual(audit['rgbSource'], 'native_rgba_inside_repair_mask')
            manifest['snapshot']['paths'] = [self.polygon([(17, 29), (21, 29), (21, 37), (17, 37)])]
            clipped, _ = PIXELS.render_region(manifest, root / 'raw.png')
            self.assertEqual(clipped.getpixel((6, 2))[3], 0)
            self.assertEqual(clipped.getpixel((1, 2)), raw.getpixel((1, 2)))
            with self.assertRaisesRegex(Exception, 'NATIVE_RGBA_SECOND_MATTE_FORBIDDEN'):
                PIXELS.render_region(manifest, root / 'raw.png', root / 'raw.png')

    @staticmethod
    def polygon(points, kind="include"):
        return {"kind": kind, "closed": True, "anchors": [
            {"x": x, "y": y, "in": {"x": x, "y": y}, "out": {"x": x, "y": y}} for x, y in points]}

    def test_pen_coverage_uses_pixel_area_and_does_not_extend_past_integer_bounds(self):
        bounds = {"x": 40, "y": 70, "width": 4, "height": 3}
        region = self.polygon([(40.5, 70), (42, 70), (42, 72), (40.5, 72)])
        mask = PIXELS.path_mask([region], bounds)
        self.assertEqual(list(mask.tobytes()), [128, 255, 0, 0, 128, 255, 0, 0, 0, 0, 0, 0])
        hole = self.polygon([(41, 70), (42, 70), (42, 71), (41, 71)], "exclude")
        self.assertEqual(PIXELS.path_mask([region, hole], bounds).getpixel((1, 0)), 0)

    def test_pen_handle_property_order_cannot_change_geometry(self):
        shape = self.polygon([(10, 20), (50, 20), (40, 60)])
        shape["anchors"][0]["out"] = {"x": 20, "y": 3}
        swapped = json.loads(json.dumps(shape))
        for anchor in swapped["anchors"]:
            for name in ("in", "out"):
                anchor[name] = {"y": anchor[name]["y"], "x": anchor[name]["x"]}
        bounds = {"x": 0, "y": 0, "width": 64, "height": 64}
        self.assertEqual(PIXELS.path_mask([shape], bounds).tobytes(), PIXELS.path_mask([swapped], bounds).tobytes())

    def test_curved_pen_edge_matches_analytic_circle_coverage(self):
        import numpy as np
        shape = self.polygon([(48, 8), (88, 48), (48, 88), (8, 48)])
        handle = 40 * 0.5522847498
        handles = [((-handle, 0), (handle, 0)), ((0, -handle), (0, handle)),
                   ((handle, 0), (-handle, 0)), ((0, handle), (0, -handle))]
        for anchor, (incoming, outgoing) in zip(shape["anchors"], handles):
            anchor["in"] = {"x": anchor["x"] + incoming[0], "y": anchor["y"] + incoming[1]}
            anchor["out"] = {"x": anchor["x"] + outgoing[0], "y": anchor["y"] + outgoing[1]}
        yy, xx = np.indices((768, 768))
        truth = ((xx + .5 - 384)**2 + (yy + .5 - 384)**2 < 320**2).reshape(96, 8, 96, 8).mean(axis=(1, 3)) * 255
        mask = np.asarray(PIXELS.path_mask([shape], {"x": 0, "y": 0, "width": 96, "height": 96}))
        self.assertLessEqual(float(np.max(np.abs(mask - truth))), 8)
        self.assertGreater(int(np.count_nonzero((mask > 0) & (mask < 255))), 200)

    def test_fractional_downsample_integrates_both_pixel_footprints(self):
        with tempfile.TemporaryDirectory() as temporary:
            raw = Image.new("L", (3, 1)); raw.putdata([0, 255, 0])
            raw_path = Path(temporary) / "matte.png"; raw.save(raw_path)
            mapping = {"canvas": {"width": 3, "height": 1},
                       "contentRegion": {"x": 0, "y": 0, "width": 3, "height": 1},
                       "sourceRegion": {"width": 2, "height": 1}}
            self.assertEqual(list(PIXELS.matte_mask(raw_path, mapping, (2, 1), "imagegen_matte").tobytes()), [85, 85])

    def test_reconstruction_downsample_preserves_thin_content_and_straight_alpha(self):
        raw = Image.new("RGBA", (5, 3), (0, 255, 0, 255))
        raw.putpixel((1, 1), (200, 60, 20, 255))
        raw.putpixel((2, 1), (0, 0, 255, 0))
        raw.putpixel((3, 1), (0, 0, 255, 0))
        mapping = {"canvas": {"width": 5, "height": 3},
                   "contentRegion": {"x": 1, "y": 1, "width": 3, "height": 1},
                   "sourceRegion": {"width": 1, "height": 1}}
        result = PIXELS.inverse_mapped_region(raw, mapping, (1, 1))
        self.assertEqual(result.getpixel((0, 0)), (200, 60, 20, 85))

    def test_reconstruction_enlargement_does_not_mix_transparent_background_rgb(self):
        raw = Image.new("RGBA", (2, 1)); raw.putdata([(200, 60, 20, 255), (0, 0, 255, 0)])
        mapping = {"canvas": {"width": 2, "height": 1},
                   "contentRegion": {"x": 0, "y": 0, "width": 2, "height": 1},
                   "sourceRegion": {"width": 4, "height": 1}}
        result = PIXELS.inverse_mapped_region(raw, mapping, (4, 1))
        self.assertEqual([result.getpixel((x, 0)) for x in range(4)], [(200,60,20,255), (200,60,20,191), (200,60,20,64), (0,0,0,0)])

    def test_small_curved_logo_coverage_matches_supersampled_ground_truth(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as temporary:
            yy, xx = np.indices((256, 256))
            radius = np.hypot(xx + .5 - 128, yy + .5 - 128)
            raw = (((radius < 93) & (radius > 72)) * 255).astype(np.uint8)
            raw_path = Path(temporary) / "ring.png"; Image.fromarray(raw).save(raw_path)
            mapping = {"canvas": {"width": 256, "height": 256},
                       "contentRegion": {"x": 0, "y": 0, "width": 256, "height": 256},
                       "sourceRegion": {"width": 32, "height": 32}}
            truth = np.rint(raw.reshape(32, 8, 32, 8).mean(axis=(1, 3))).astype(np.uint8)
            result = np.asarray(PIXELS.matte_mask(raw_path, mapping, (32, 32), "imagegen_matte"))
            np.testing.assert_array_equal(result, truth)
            self.assertGreater(np.count_nonzero((result > 0) & (result < 255)), 120)
            self.assertEqual(int(result[16, 16]), 0, "preserve the counter")

    def test_downsampled_matte_preserves_fractional_coverage_and_ignores_padding(self):
        # Each destination pixel covers a 4x4 source block. A 1px white column
        # covers 25%, even though it misses the point sampled by nearest-neighbor.
        with tempfile.TemporaryDirectory() as temporary:
            raw = Image.new("L", (12, 8), 255)
            ImageDraw.Draw(raw).rectangle((2, 2, 9, 5), fill=0)
            ImageDraw.Draw(raw).line((2, 2, 2, 5), fill=255)
            ImageDraw.Draw(raw).rectangle((6, 2, 7, 5), fill=255)
            raw_path = Path(temporary) / "matte.png"; raw.save(raw_path)
            mapping = {"canvas": {"width": 12, "height": 8},
                       "contentRegion": {"x": 2, "y": 2, "width": 8, "height": 4},
                       "sourceRegion": {"width": 2, "height": 1}}
            result = PIXELS.matte_mask(raw_path, mapping, (2, 1), "imagegen_matte")
            self.assertEqual(list(result.tobytes()), [64, 128])

    def test_matte_enlargement_preserves_soft_transition_without_ringing(self):
        with tempfile.TemporaryDirectory() as temporary:
            raw = Image.new("L", (2, 1)); raw.putdata([0, 255])
            raw_path = Path(temporary) / "matte.png"; raw.save(raw_path)
            mapping = {"canvas": {"width": 2, "height": 1},
                       "contentRegion": {"x": 0, "y": 0, "width": 2, "height": 1},
                       "sourceRegion": {"width": 4, "height": 1}}
            result = PIXELS.matte_mask(raw_path, mapping, (4, 1), "imagegen_matte")
            self.assertEqual(list(result.tobytes()), [0, 64, 191, 255])

    def test_soft_edges_recompose_without_double_background_contamination(self):
        with tempfile.TemporaryDirectory() as temporary:
            truth = Image.new("L", (128, 80), 0)
            ImageDraw.Draw(truth).rectangle((20, 20, 107, 59), fill=255)
            truth = truth.filter(ImageFilter.GaussianBlur(2))
            source = Image.composite(Image.new("RGB", truth.size, (0, 0, 0)),
                                     Image.new("RGB", truth.size, (255, 255, 255)), truth).convert("RGBA")
            result, output_path = self.refine_fixture(Path(temporary), source, truth, "text")
            self.assertEqual(result.returncode, 0, result.stderr)
            cutout = Image.open(output_path).convert("RGBA")
            for color in ((255,255,255,255), (40,80,120,255)):
                background = Image.new("RGBA", truth.size, color)
                recomposed = Image.alpha_composite(background, cutout)
                expected = Image.composite(Image.new("RGBA", truth.size, (0,0,0,255)), background, truth)
                self.assertLessEqual(max(abs(a-b) for a,b in zip(recomposed.tobytes(), expected.tobytes())), 1)

    def test_possible_missing_content_is_retained_for_inspection_not_reported_as_clean(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (128,80), (20,20,20,255))
            draw = ImageDraw.Draw(source)
            draw.rectangle((20,20,44,59), fill=(220,220,220,255))
            draw.rectangle((75,20,99,59), fill=(220,220,220,255))
            matte = Image.new("L", source.size, 0)
            ImageDraw.Draw(matte).rectangle((20,20,44,59), fill=255)
            result, output = self.refine_fixture(Path(temporary), source, matte, "text")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["status"], "needs_review")
            self.assertEqual(Image.open(output).getpixel((80,30))[3], 0)

    def refine_fixture(self, root, source, matte, category="brand_ui", paths=None):
        crop = root / "crop.png"; source.save(crop)
        raw = root / "matte.png"; matte.save(raw)
        manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
            "selectedCropPath": str(crop), "snapshot": {"processingCategory": category,
            "bounds": {"x": 37, "y": 91, "width": source.width, "height": source.height},
            "paths": paths or [], "strategy": {"repairPaths": []}}}
        manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
        result = self.run_cli(manifest_path, raw, root / "out.png")
        return result, root / "out.png"

    def test_uncertain_source_contour_returns_a_diagnostic_png_with_reason(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (128, 80))
            source.putdata([(100+x%5+y%7,)*3+(255,) for y in range(80) for x in range(128)])
            matte = Image.new("L", source.size, 0)
            ImageDraw.Draw(matte).rectangle((20,20,107,59), fill=255)
            result, output = self.refine_fixture(Path(temporary), source, matte, "text")
            self.assertEqual(result.returncode, 0, result.stderr)
            audit = json.loads(result.stdout)
            self.assertEqual(audit["status"], "needs_review")
            self.assertIn("SOURCE_BOUNDARY_UNCERTAIN", audit["sourceGeometryAlignment"]["reviewReasons"])
            with Image.open(output) as image:
                self.assertEqual(image.size, source.size)

    def test_source_guided_ui_edges_correct_small_shift_and_remove_invented_protrusion(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (128, 80), (12, 24, 48, 255))
            ImageDraw.Draw(source).rectangle((20, 20, 107, 55), fill=(110, 70, 210, 255))
            matte = Image.new("RGB", source.size, "black")
            draw = ImageDraw.Draw(matte)
            draw.rectangle((23, 22, 110, 57), fill=(250, 250, 250))
            draw.polygon([(52, 57), (60, 63), (68, 57)], fill="white")
            result, output_path = self.refine_fixture(Path(temporary), source, matte)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(output_path).convert("RGBA")
            self.assertEqual(output.getpixel((20, 30))[3], 255, "recover the original left edge")
            self.assertEqual(output.getpixel((109, 30))[3], 0, "remove shifted background")
            self.assertEqual(output.getpixel((60, 61))[3], 0, "remove invented protrusion")
            self.assertEqual(output.getpixel((60, 40))[3], 255, "matte texture must not make an opaque interior translucent")
            self.assertEqual(output.convert("RGB").tobytes(), source.convert("RGB").tobytes())
            self.assertEqual(json.loads(result.stdout)["placement"], {"x": 37, "y": 91})

    def test_source_guided_text_preserves_thin_strokes_holes_and_source_antialias(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (96, 64), (10, 10, 10, 255))
            draw = ImageDraw.Draw(source)
            draw.rectangle((20, 15, 49, 44), fill=(210, 210, 210, 255))
            draw.rectangle((24, 19, 45, 40), fill=(10, 10, 10, 255))
            draw.line((65, 15, 65, 44), fill=(210, 210, 210, 255))
            draw.line((19, 18, 19, 41), fill=(110, 110, 110, 255))
            matte = Image.new("RGB", source.size, "black"); md = ImageDraw.Draw(matte)
            md.rectangle((20, 15, 49, 44), fill="white"); md.rectangle((24, 19, 45, 40), fill="black")
            md.line((65, 15, 65, 44), fill="white")
            result, output_path = self.refine_fixture(Path(temporary), source, matte, "text")
            self.assertEqual(result.returncode, 0, result.stderr)
            alpha = Image.open(output_path).getchannel("A")
            self.assertEqual(alpha.getpixel((65, 25)), 255)
            self.assertEqual(alpha.getpixel((30, 30)), 0)
            self.assertTrue(110 <= alpha.getpixel((19, 25)) <= 145, "edge alpha must come from source color, not a binary matte")

    def test_ui_matte_with_no_source_edge_evidence_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (128, 80), (30, 40, 50, 255))
            matte = Image.new("RGB", source.size, "black")
            ImageDraw.Draw(matte).rectangle((20, 20, 107, 55), fill="white")
            result, output_path = self.refine_fixture(Path(temporary), source, matte)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("MATTE_SOURCE_GEOMETRY_MISMATCH", result.stderr)
            self.assertFalse(output_path.exists())

    def test_ui_large_offset_is_not_silently_recentred(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (128, 80), (10, 20, 30, 255))
            ImageDraw.Draw(source).rectangle((12, 20, 50, 55), fill=(230, 160, 100, 255))
            matte = Image.new("RGB", source.size, "black")
            ImageDraw.Draw(matte).rectangle((72, 20, 110, 55), fill="white")
            result, output_path = self.refine_fixture(Path(temporary), source, matte)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("MATTE_SOURCE_GEOMETRY_MISMATCH", result.stderr)
            self.assertFalse(output_path.exists())

    def test_refinement_preserves_source_alpha_and_user_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Image.new("RGBA", (128, 80), (10, 20, 30, 255))
            ImageDraw.Draw(source).rectangle((20, 20, 107, 55), fill=(200, 140, 100, 128))
            matte = Image.new("RGB", source.size, "black")
            ImageDraw.Draw(matte).rectangle((20, 20, 107, 55), fill="white")
            anchors = [{"x": x+37, "y": y+91, "in": {"x": x+37, "y": y+91}, "out": {"x": x+37, "y": y+91}}
                       for x, y in [(40, 30), (60, 30), (60, 45), (40, 45)]]
            result, output_path = self.refine_fixture(Path(temporary), source, matte, paths=[{"kind": "exclude", "closed": True, "anchors": anchors}])
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(output_path).convert("RGBA")
            self.assertEqual(output.getpixel((80, 35))[3], 128)
            self.assertEqual(output.getpixel((50, 35))[3], 0)
            self.assertEqual(output.convert("RGB").tobytes(), source.convert("RGB").tobytes())

    def test_invalid_inverse_mapping_cannot_sample_outside_reference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = Image.new("RGBA", (2, 2), (10, 20, 30, 255)); source.save(root / "crop.png")
            Image.new("RGB", (6, 6), "white").save(root / "raw.png")
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
                "selectedCropPath": str(root / "crop.png"), "snapshot": {"bounds": {"x": 37, "y": 91, "width": 2, "height": 2}},
                "mapping": {"canvas": {"width": 6, "height": 6}, "contentRegion": {"x": -1, "y": 2, "width": 2, "height": 2},
                            "sourceRegion": {"width": 2, "height": 2}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, root / "raw.png", root / "out.png")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("INVALID_REFERENCE_MAPPING", result.stderr)

    def run_cli(self, manifest, raw, output, matte=None):
        command = [str(__import__("sys").executable), str(SCRIPT), "--manifest", str(manifest), "--raw", str(raw), "--output", str(output)]
        if matte is not None:
            command += ["--matte", str(matte)]
        return subprocess.run(command, check=False, text=True, capture_output=True)

    def test_extract_retains_frozen_crop_rgb_alpha_and_original_placement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = Image.new("RGBA", (4, 3), (20, 90, 180, 255))
            matte = Image.new("RGBA", (6, 6), (0, 0, 0, 255))
            matte.putpixel((2, 2), (255, 255, 255, 255))
            raw = root / "matte.png"; matte.save(raw)
            matte_path = root / "matte.png"
            crop = root / "crop.png"; base.crop((1, 1, 3, 3)).save(crop)
            report = root / "report.json"
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
                "selectedCropPath": str(crop), "outputPath": str(root / "out.png"), "reportPath": str(report),
                "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 2, "height": 2}, "strategy": {"repairPaths": []}},
                "mapping": {"canvas": {"width": 6, "height": 6}, "contentRegion": {"x": 2, "y": 2, "width": 2, "height": 2}, "sourceRegion": {"width": 2, "height": 2}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, raw, root / "out.png", matte_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(root / "out.png").convert("RGBA")
            self.assertEqual(output.size, (2, 2))
            self.assertEqual(output.getpixel((0, 0))[:3], base.getpixel((1, 1))[:3])
            self.assertEqual(output.getpixel((0, 0))[3], 255)
            self.assertEqual(output.getpixel((1, 1))[3], 0)
            report_data = json.loads(report.read_text())
            self.assertEqual(report_data["placement"], {"x": 129, "y": 1522})
            self.assertEqual(report_data["rgbSource"], "frozen_crop")

    def test_reconstruction_cannot_change_pixels_outside_authorized_repair_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = Image.new("RGBA", (8, 6), (10, 20, 30, 255)); crop_path = root / "crop.png"; crop.save(crop_path)
            raw_path = root / "generated.png"; Image.new("RGBA", (8, 6), (210, 110, 20, 255)).save(raw_path)
            manifest = {"schemaVersion": 2, "route": "reconstruct", "maskProvider": "generated_region", "removeBackground": False,
                "selectedCropPath": str(crop_path), "snapshot": {"bounds": {"x": 40, "y": 70, "width": 8, "height": 6},
                "strategy": {"repairPaths": [{"kind": "include", "closed": True, "anchors": [{"x": 41, "y": 71, "in": {"x": 41, "y": 71}, "out": {"x": 41, "y": 71}}, {"x": 44, "y": 71, "in": {"x": 44, "y": 71}, "out": {"x": 44, "y": 71}}, {"x": 44, "y": 74, "in": {"x": 44, "y": 74}, "out": {"x": 44, "y": 74}}, {"x": 41, "y": 74, "in": {"x": 41, "y": 74}, "out": {"x": 41, "y": 74}}]}]}},
                "outputPath": str(root / "out.png")}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, raw_path, root / "out.png")
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(root / "out.png").convert("RGBA")
            self.assertEqual(output.getpixel((0, 0)), (10, 20, 30, 255))
            self.assertEqual(output.getpixel((2, 2)), (210, 110, 20, 255))
            self.assertEqual(output.getpixel((4, 2)), (10, 20, 30, 255), "pixel starts at the exclusive right edge")
            manifest["snapshot"]["strategy"]["repairPaths"] = [self.polygon([(41.5,71),(44,71),(44,74),(41.5,74)])]
            manifest_path.write_text(json.dumps(manifest))
            fractional = self.run_cli(manifest_path, raw_path, root / "fractional.png")
            self.assertEqual(fractional.returncode, 0, fractional.stderr)
            self.assertEqual(Image.open(root / "fractional.png").getpixel((1, 2)), (110, 65, 25, 255))

    def test_padded_imagegen_matte_requires_inverse_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = root / "crop.png"; Image.new("RGBA", (2, 2), (10, 20, 30, 255)).save(crop)
            matte = root / "matte.png"; Image.new("RGB", (6, 6), "white").save(matte)
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
                "selectedCropPath": str(crop), "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 2, "height": 2}, "strategy": {"repairPaths": []}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            raw_path = root / "raw.png"; Image.new("RGBA", (2, 2), "white").save(raw_path)
            result = self.run_cli(manifest_path, raw_path, root / "out.png", matte)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("MAPPING_REQUIRED_FOR_PADDED_MATTE", result.stderr)

    def test_padded_reconstruction_inverse_maps_only_the_reference_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = root / "crop.png"; Image.new("RGBA", (2, 2), (10, 20, 30, 255)).save(crop)
            raw = Image.new("RGBA", (6, 6), (0, 0, 0, 255))
            for y in range(2, 4):
                for x in range(2, 4): raw.putpixel((x, y), (230, 80, 30, 255))
            raw_path = root / "generated.png"; raw.save(raw_path)
            mapping = {"canvas": {"width": 6, "height": 6}, "contentRegion": {"x": 2, "y": 2, "width": 2, "height": 2},
                "sourceRegion": {"width": 2, "height": 2}}
            mapping_path = root / "mapping.json"; mapping_path.write_text(json.dumps(mapping))
            manifest = {"schemaVersion": 2, "route": "reconstruct", "maskProvider": "generated_region", "removeBackground": False,
                "selectedCropPath": str(crop), "mappingPath": str(mapping_path), "outputRoot": str(root),
                "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 2, "height": 2}, "strategy": {"repairPaths": []}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            result = self.run_cli(manifest_path, raw_path, root / "out.png")
            self.assertEqual(result.returncode, 0, result.stderr)
            output = Image.open(root / "out.png").convert("RGBA")
            self.assertEqual(output.getpixel((0, 0)), (230, 80, 30, 255))

    def test_same_sized_reference_canvas_still_removes_padding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = root / "crop.png"; Image.new("RGBA", (6, 6), (10, 20, 30, 255)).save(crop)
            raw = Image.new("RGBA", (6, 6), (0, 255, 0, 255))
            ImageDraw.Draw(raw).rectangle((2, 2, 3, 3), fill=(230, 80, 30, 255))
            raw_path = root / "generated.png"; raw.save(raw_path)
            manifest = {"schemaVersion": 2, "route": "reconstruct", "maskProvider": "generated_region", "removeBackground": False,
                "rawCoordinateSpace": "reference_canvas", "selectedCropPath": str(crop), "outputRoot": str(root),
                "mapping": {"canvas": {"width": 6, "height": 6}, "contentRegion": {"x": 2, "y": 2, "width": 2, "height": 2},
                            "sourceRegion": {"width": 6, "height": 6}},
                "snapshot": {"bounds": {"x": 129, "y": 1522, "width": 6, "height": 6}, "strategy": {"repairPaths": []}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            processed = self.run_cli(manifest_path, raw_path, root / "out.png")
            self.assertEqual(processed.returncode, 0, processed.stderr)
            self.assertEqual(Image.open(root / "out.png").getpixel((0, 0)), (230, 80, 30, 255))

    def test_transparent_and_fully_opaque_background_removal_are_not_false_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop_path = root / "crop.png"; Image.new("RGBA", (2, 2), (10, 20, 30, 255)).save(crop_path)
            raw_path = root / "candidate.png"; Image.new("RGBA", (2, 2), (210, 110, 20, 255)).save(raw_path)
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "bria", "removeBackground": True,
                "selectedCropPath": str(crop_path), "snapshot": {"bounds": {"x": 5, "y": 9, "width": 2, "height": 2}, "strategy": {"repairPaths": []}}, "outputPath": str(root / "out.png")}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))
            matte = root / "matte.png"; Image.new("RGBA", (2, 2), (0, 0, 0, 0)).save(matte)
            failed = self.run_cli(manifest_path, raw_path, root / "transparent.png", matte)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("ALL_TRANSPARENT", failed.stderr)
            matte = root / "opaque.png"; Image.new("RGBA", (2, 2), (255, 255, 255, 255)).save(matte)
            opaque = self.run_cli(manifest_path, raw_path, root / "opaque-output.png", matte)
            self.assertEqual(opaque.returncode, 0, opaque.stderr)
            self.assertEqual(json.loads(opaque.stdout)["status"], "needs_review")
            # BRIA returns RGBA, not a grayscale semantic mask. Dark RGB must
            # never become transparency when background removal did nothing.
            colored = root / "colored.png"; Image.new("RGBA", (2, 2), (25, 80, 160, 255)).save(colored)
            rejected = self.run_cli(manifest_path, raw_path, root / "colored-output.png", colored)
            self.assertEqual(rejected.returncode, 0, rejected.stderr)
            self.assertEqual(json.loads(rejected.stdout)["status"], "needs_review")
            self.assertEqual(Image.open(root / "colored-output.png").getchannel("A").getextrema(), (255, 255))

    def test_text_matte_must_follow_the_frozen_source_geometry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crop = Image.new("RGBA", (64, 48), (8, 10, 14, 255))
            for y in range(10, 38):
                for x in range(14, 24):
                    crop.putpixel((x, y), (245, 232, 216, 255))
            crop_path = root / "crop.png"; crop.save(crop_path)
            manifest = {"schemaVersion": 2, "route": "extract_mask", "maskProvider": "imagegen_matte", "removeBackground": True,
                "selectedCropPath": str(crop_path), "snapshot": {"processingCategory": "text",
                "bounds": {"x": 100, "y": 200, "width": 64, "height": 48}, "strategy": {"repairPaths": []}}}
            manifest_path = root / "manifest.json"; manifest_path.write_text(json.dumps(manifest))

            aligned = Image.new("RGB", (64, 48), "black")
            for y in range(10, 38):
                for x in range(14, 24):
                    aligned.putpixel((x, y), (255, 255, 255))
            aligned_path = root / "aligned.png"; aligned.save(aligned_path)
            accepted = self.run_cli(manifest_path, aligned_path, root / "aligned-output.png", aligned_path)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertGreaterEqual(json.loads(accepted.stdout)["sourceGeometryAlignment"]["boundaryMatchRatio"], 0.7)

            shifted = Image.new("RGB", (64, 48), "black")
            for y in range(10, 38):
                for x in range(26, 36):
                    shifted.putpixel((x, y), (255, 255, 255))
            shifted_path = root / "shifted.png"; shifted.save(shifted_path)
            recovered = self.run_cli(manifest_path, shifted_path, root / "shifted-output.png", shifted_path)
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            self.assertTrue(json.loads(recovered.stdout)['sourceGeometryAlignment']['globalRegistration']['applied'])
            self.assertEqual(Image.open(root/'shifted-output.png').tobytes(),
                             Image.open(root/'aligned-output.png').tobytes(),
                             'a repairable global offset must produce the exact frozen-source result')
            self.assertEqual(json.loads(recovered.stdout)['placement'], {'x': 100, 'y': 200})

            distant = Image.new('RGB', (64, 48), 'black')
            ImageDraw.Draw(distant).rectangle((46, 10, 55, 37), fill='white')
            distant_path = root/'distant.png'; distant.save(distant_path)
            rejected = self.run_cli(manifest_path, distant_path, root / "distant-output.png", distant_path)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("MATTE_SOURCE_GEOMETRY_MISMATCH", rejected.stderr)

    def test_export_decoder_returns_straight_rgba_and_checks_frozen_dimensions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            png = root / "candidate.png"
            Image.new("RGBA", (2, 1), (40, 80, 120, 128)).save(png)
            rgba = root / "candidate.rgba"
            command = [str(__import__("sys").executable), str(SCRIPT), "--decode-png", str(png),
                "--expected-width", "2", "--expected-height", "1", "--output", str(rgba)]
            decoded = subprocess.run(command, check=False, text=True, capture_output=True)
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
            self.assertEqual(json.loads(decoded.stdout), {"width": 2, "height": 1, "channels": 4, "format": "RGBA"})
            self.assertEqual(rgba.read_bytes(), bytes([40, 80, 120, 128]) * 2)
            mismatch = subprocess.run(command[:-1] + [str(root / "wrong.rgba"), "--expected-width", "3"],
                check=False, text=True, capture_output=True)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("PNG_DIMENSIONS_MISMATCH", mismatch.stderr)


if __name__ == "__main__":
    unittest.main()
