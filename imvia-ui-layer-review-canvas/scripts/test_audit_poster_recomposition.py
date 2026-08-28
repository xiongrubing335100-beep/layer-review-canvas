import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).with_name('audit-poster-recomposition.py')
SPEC = importlib.util.spec_from_file_location('audit_poster_recomposition', SCRIPT)
AUDIT_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT_MODULE)


class PosterAuditCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='poster-audit-')
        self.job = Path(self.temporary.name)
        (self.job / 'layers').mkdir()
        (self.job / 'candidates').mkdir()
        self.canvas_size = (4, 3)

    def tearDown(self):
        self.temporary.cleanup()

    def write_layer(self, index, *, fill, marker, size=(4, 3), mode='RGB'):
        image = Image.new(mode, size, fill if mode == 'RGB' else (*fill, 255))
        image.putpixel(marker, (255, 0, 0) if mode == 'RGB' else (255, 0, 0, 255))
        target = self.job / 'layers' / f'layer_{index}_source.png'
        image.save(target)
        return target, hashlib.sha256(target.read_bytes()).hexdigest()

    def write_pixels(self, target, pixels, size=None):
        size = size or self.canvas_size
        image = Image.new('RGB', size)
        image.putdata(pixels)
        image.save(target)
        return target, hashlib.sha256(target.read_bytes()).hexdigest()

    def write_metadata(self, plan_layers, manifest_layers):
        candidates = []
        for state in manifest_layers:
            index = state['layer_index']
            candidate_id = f'candidate-{index}'
            candidate_path = str(self.job / 'candidates' / f'layer_{index}.png')
            Image.new('RGB', self.canvas_size, (index * 30, 10, 20)).save(candidate_path)
            candidate_sha = hashlib.sha256(Path(candidate_path).read_bytes()).hexdigest()
            inspection = state.get('visual_inspection', {})
            state.update({
                'accepted_candidate_id': candidate_id,
                'candidate_output': candidate_path,
                'generation_count': 1,
                'visual_inspection': {
                    'candidate_id': candidate_id, 'plan_version': 4,
                    'candidate_sha256': candidate_sha,
                    **inspection,
                },
            })
            candidates.append({
                'candidate_id': candidate_id, 'candidate_number': 1, 'layer_index': index,
                'plan_version': 4, 'path': candidate_path, 'status': 'NEEDS_USER_REVIEW',
                'failure_codes': [], 'candidate_sha256': candidate_sha, 'accepted': True,
                'accepted_source_output': state['source_output'],
                'accepted_source_sha256': state['source_sha256'],
                'release_gate': {
                    'verdict': 'NEEDS_USER_REVIEW', 'failureCodes': [],
                    'checks': {
                        'source_comparison': True, 'locked_anchors': True,
                        'repair_envelope': True, 'canvas_dimensions': True, 'key_field': True,
                    },
                    'candidateId': candidate_id, 'planVersion': 4,
                    'candidateSha256': candidate_sha,
                },
            })
        (self.job / 'poster-layer-plan.json').write_text(json.dumps({
            'status': 'PLAN_CONFIRMED', 'plan_version': 4,
            'source': {'width': self.canvas_size[0], 'height': self.canvas_size[1]}, 'layers': plan_layers,
        }), encoding='utf-8')
        (self.job / 'layer_manifest.json').write_text(json.dumps({
            'revision': 9, 'layers': manifest_layers, 'candidates': candidates,
        }), encoding='utf-8')

    def write_reconstructing_fixture(self, *, overlap=False, leak=False, missing=False, z_orders=(1, 2)):
        red = (255, 0, 0)
        blue = (20, 40, 80)
        green = (0, 255, 0)
        source_pixels = [red, red, red] + [blue] * 9
        self.write_pixels(self.job / 'source.png', source_pixels)
        foreground_pixels = [red, green if missing else red, red] + [green] * 9
        background_pixels = [red if overlap else green, green, green] + [blue] * 9
        if leak:
            foreground_pixels[4] = (255, 255, 0)
        foreground, foreground_digest = self.write_pixels(
            self.job / 'layers' / 'layer_1_source.png', foreground_pixels,
        )
        background, background_digest = self.write_pixels(
            self.job / 'layers' / 'layer_2_source.png', background_pixels,
        )
        self.write_metadata(
            [
                {
                    'layer_index': 1, 'z_order': z_orders[0], 'layer_name': 'headline',
                    'included_content': ['headline'], 'fill_color': '#00FF00',
                    'compositing_mode': 'Normal', 'occludes': [], 'occluded_by': [],
                },
                {
                    'layer_index': 2, 'z_order': z_orders[1], 'layer_name': 'background',
                    'included_content': ['background'], 'fill_color': '#00FF00',
                    'compositing_mode': 'Normal', 'occludes': [], 'occluded_by': [],
                },
            ],
            [
                self.state(1, foreground, foreground_digest, '#00FF00'),
                self.state(2, background, background_digest, '#00FF00'),
            ],
        )
        return foreground_digest, background_digest

    def write_threshold_fixture(self, mismatch_count, mismatch_color=(255, 255, 0)):
        self.canvas_size = (20, 10)
        blue = (20, 40, 80)
        source_pixels = [blue] * 200
        layer_pixels = [mismatch_color] * mismatch_count + [blue] * (200 - mismatch_count)
        self.write_pixels(self.job / 'source.png', source_pixels)
        layer, layer_digest = self.write_pixels(
            self.job / 'layers' / 'layer_1_source.png', layer_pixels,
        )
        self.write_metadata(
            [{
                'layer_index': 1, 'z_order': 10, 'layer_name': 'background',
                'included_content': ['background'], 'fill_color': '#00FF00',
                'compositing_mode': 'Normal', 'occludes': [], 'occluded_by': [],
            }],
            [self.state(1, layer, layer_digest, '#00FF00')],
        )

    def run_audit(self):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), '--job-directory', str(self.job)],
            check=False, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    @staticmethod
    def state(index, target, digest, fill_color, compositing_mode='Normal', **overrides):
        return {
            'layer_index': index, 'status': 'ACCEPTED', 'accepted_plan_version': 4,
            'source_output': str(target), 'source_sha256': digest,
            'fill_color': fill_color, 'compositing_mode': compositing_mode,
            'visual_inspection': {'performed': True, 'verdict': 'NEEDS_USER_REVIEW', 'failure_codes': []},
            **overrides,
        }

    def test_passed_audit_composites_back_to_front_and_writes_preview_outside_layers(self):
        foreground_digest, background_digest = self.write_reconstructing_fixture()

        report = self.run_audit()

        self.assertEqual(report['status'], 'passed')
        self.assertEqual(report['composite_order'], [2, 1])
        self.assertEqual(report['failure_codes'], [])
        self.assertEqual([entry['source_sha256'] for entry in report['accepted_layers']], [background_digest, foreground_digest])
        self.assertEqual(report['measurements']['coverage_ratio'], 1.0)
        self.assertEqual(report['measurements']['source_similarity'], 1.0)
        self.assertEqual(report['measurements']['mean_absolute_error'], 0.0)
        self.assertEqual(report['measurements']['undeclared_overlap_pixels'], 0)
        self.assertTrue(all(report['checks'].values()))
        preview = Path(report['preview_path'])
        self.assertTrue(preview.is_file())
        self.assertNotEqual(preview.parent, self.job / 'layers')
        with Image.open(preview) as image:
            self.assertEqual(image.mode, 'RGB')
            self.assertEqual(image.size, (4, 3))
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
            self.assertEqual(image.getpixel((3, 2)), (20, 40, 80))

    def test_valid_non_contiguous_monotonic_z_order_composites_by_authoritative_relationship(self):
        self.write_reconstructing_fixture(z_orders=(10, 20))

        report = self.run_audit()

        self.assertEqual(report['status'], 'passed')
        self.assertEqual(report['composite_order'], [2, 1])

    def test_similarity_and_mae_threshold_accept_one_of_200_mismatches_but_reject_two(self):
        self.write_threshold_fixture(1)
        boundary = self.run_audit()
        self.assertEqual(boundary['status'], 'passed')
        self.assertEqual(boundary['measurements']['source_similarity'], 0.995)
        self.assertEqual(boundary['measurements']['mismatch_pixels'], 1)

        self.write_threshold_fixture(2)
        beyond = self.run_audit()
        self.assertEqual(beyond['status'], 'failed')
        self.assertIn('SOURCE_RECOMPOSITION_MISMATCH', beyond['failure_codes'])
        self.assertIn('FOREIGN_CONTENT_LEAK', beyond['failure_codes'])
        self.assertEqual(beyond['measurements']['source_similarity'], 0.99)

        self.write_threshold_fixture(1, mismatch_color=(255, 255, 255))
        mae_beyond = self.run_audit()
        self.assertEqual(mae_beyond['measurements']['source_similarity'], 0.995)
        self.assertGreater(mae_beyond['measurements']['mean_absolute_error'], 1.0)
        self.assertEqual(mae_beyond['status'], 'failed')
        self.assertIn('SOURCE_RECOMPOSITION_MISMATCH', mae_beyond['failure_codes'])

    def test_unrelated_layer_pixels_fail_source_similarity_and_leakage(self):
        self.write_reconstructing_fixture(leak=True)

        report = self.run_audit()

        self.assertEqual(report['status'], 'failed')
        self.assertIn('FOREIGN_CONTENT_LEAK', report['failure_codes'])
        self.assertIn('SOURCE_RECOMPOSITION_MISMATCH', report['failure_codes'])
        self.assertIn(1, report['conflict_layers'])
        self.assertGreater(report['measurements']['mismatch_pixels'], 0)

    def test_missing_owned_source_pixel_fails_coverage_and_completion(self):
        self.write_reconstructing_fixture(missing=True)

        report = self.run_audit()

        self.assertEqual(report['status'], 'failed')
        self.assertIn('MISSING_OWNED_PIXELS', report['failure_codes'])
        self.assertIn('COMPLETION_MISSING', report['failure_codes'])
        self.assertLess(report['measurements']['coverage_ratio'], 1.0)

    def test_undeclared_layer_overlap_fails_even_when_recomposition_matches_source(self):
        self.write_reconstructing_fixture(overlap=True)

        report = self.run_audit()

        self.assertEqual(report['status'], 'failed')
        self.assertIn('OWNERSHIP_OVERLAP', report['failure_codes'])
        self.assertEqual(report['measurements']['source_similarity'], 1.0)
        self.assertGreater(report['measurements']['undeclared_overlap_pixels'], 0)
        self.assertEqual(report['conflict_layers'], [1, 2])

    def test_audit_reports_missing_layer_dimension_key_metadata_and_visual_failures(self):
        Image.new('RGB', (4, 3), (80, 90, 100)).save(self.job / 'source.png')
        invalid, invalid_digest = self.write_layer(1, fill=(0, 255, 0), marker=(0, 0), size=(5, 3), mode='RGBA')
        missing = self.job / 'layers' / 'missing.png'
        self.write_metadata(
            [
                {'layer_index': 1, 'included_content': ['shared'], 'fill_color': '#00FF00', 'compositing_mode': 'Screen'},
                {'layer_index': 2, 'included_content': ['shared'], 'fill_color': '#00FF00', 'compositing_mode': 'Normal'},
            ],
            [
                self.state(1, invalid, invalid_digest, '#00FF00', 'Screen', visual_inspection={
                    'performed': True, 'verdict': 'HARD_REJECTED', 'failure_codes': ['TEXT_OR_LOGO_MUTATED'],
                }),
                self.state(2, missing, 'f' * 64, '#00FF00'),
            ],
        )

        report = self.run_audit()

        self.assertEqual(report['status'], 'failed')
        self.assertTrue({
            'MISSING_ACCEPTED_LAYER', 'DUPLICATE_OWNED_CONTENT', 'INVALID_KEY_FIELDS',
            'DIMENSION_MISMATCH', 'NON_RGB_CANONICAL_LAYER', 'VISUAL_OWNERSHIP_BLOCKED',
        }.issubset(report['failure_codes']))
        self.assertEqual(report['conflict_layers'], [1, 2])

    def test_audit_fails_manifest_digest_and_plan_index_inconsistencies_closed(self):
        Image.new('RGB', (4, 3), (80, 90, 100)).save(self.job / 'source.png')
        layer, layer_digest = self.write_layer(1, fill=(0, 0, 0), marker=(0, 0))
        self.write_metadata(
            [{'layer_index': 1, 'included_content': ['glow'], 'fill_color': '#000000', 'compositing_mode': 'Add'}],
            [self.state(2, layer, layer_digest, '#000000', 'Add')],
        )

        report = self.run_audit()

        self.assertEqual(report['status'], 'failed')
        self.assertIn('MANIFEST_INCONSISTENCY', report['failure_codes'])
        self.assertFalse(Path(report['preview_path']).exists())

    def test_audit_rejects_a_symlink_instead_of_treating_its_target_as_canonical(self):
        Image.new('RGB', (4, 3), (80, 90, 100)).save(self.job / 'source.png')
        target, target_digest = self.write_layer(9, fill=(0, 255, 0), marker=(0, 0))
        linked = self.job / 'layers' / 'layer_1_source.png'
        linked.symlink_to(target.name)
        self.write_metadata(
            [{'layer_index': 1, 'included_content': ['headline'], 'fill_color': '#00FF00', 'compositing_mode': 'Normal'}],
            [self.state(1, linked, target_digest, '#00FF00')],
        )

        report = self.run_audit()

        self.assertEqual(report['status'], 'failed')
        self.assertIn('MISSING_ACCEPTED_LAYER', report['failure_codes'])
        self.assertEqual(report['conflict_layers'], [1])

    def test_audit_hashes_the_exact_raw_candidate_and_rejects_missing_replaced_or_symlinked_bytes(self):
        for mutation in ('missing', 'replaced', 'symlink', 'outside'):
            with self.subTest(mutation=mutation):
                self.write_reconstructing_fixture()
                candidate = self.job / 'candidates' / 'layer_1.png'
                if mutation == 'missing':
                    candidate.unlink()
                elif mutation == 'replaced':
                    Image.new('RGB', self.canvas_size, (250, 1, 2)).save(candidate)
                else:
                    outside = self.job / 'candidate-outside.png'
                    Image.new('RGB', self.canvas_size, (1, 2, 3)).save(outside)
                    if mutation == 'symlink':
                        candidate.unlink()
                        candidate.symlink_to(outside)
                    else:
                        outside_digest = hashlib.sha256(outside.read_bytes()).hexdigest()
                        manifest_path = self.job / 'layer_manifest.json'
                        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                        manifest['layers'][0]['candidate_output'] = str(outside)
                        manifest['layers'][0]['visual_inspection']['candidate_sha256'] = outside_digest
                        manifest['candidates'][0]['path'] = str(outside)
                        manifest['candidates'][0]['candidate_sha256'] = outside_digest
                        manifest['candidates'][0]['release_gate']['candidateSha256'] = outside_digest
                        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')

                report = self.run_audit()

                self.assertEqual(report['status'], 'failed')
                self.assertIn('MISSING_ACCEPTED_CANDIDATE', report['failure_codes'])
                self.assertIn(1, report['conflict_layers'])
                self.assertFalse(report['checks']['accepted_binding'])

    def test_pinned_candidates_directory_never_accepts_outside_bytes_after_ancestor_swap(self):
        self.write_reconstructing_fixture()
        original_root = self.job / 'candidates'
        original_candidate = original_root / 'layer_1.png'
        accepted_bytes = original_candidate.read_bytes()

        def swap_after_open(_descriptor):
            held = self.job / 'candidates-held'
            outside = self.job / 'candidates-outside'
            original_root.rename(held)
            outside.mkdir()
            (outside / 'layer_1.png').write_bytes(accepted_bytes)
            original_root.symlink_to(outside, target_is_directory=True)
            (held / 'layer_1.png').unlink()

        report = AUDIT_MODULE.audit_job(self.job, hooks={
            'after_candidates_directory_opened': swap_after_open,
        })

        self.assertEqual(report['status'], 'failed')
        self.assertIn('MISSING_ACCEPTED_CANDIDATE', report['failure_codes'])
        self.assertFalse(report['checks']['accepted_binding'])

    def test_symlinked_audit_directory_never_overwrites_or_unlinks_external_preview(self):
        for failing in (False, True):
            with self.subTest(failing=failing):
                if (self.job / 'audit').exists() or (self.job / 'audit').is_symlink():
                    (self.job / 'audit').unlink()
                external = Path(self.temporary.name) / f'external-{failing}'
                external.mkdir()
                sentinel = external / 'recomposition-preview.png'
                sentinel.write_bytes(b'outside-sentinel')
                (self.job / 'audit').symlink_to(external, target_is_directory=True)
                self.write_reconstructing_fixture(leak=failing)

                report = self.run_audit()

                self.assertEqual(report['status'], 'failed')
                self.assertIn('AUDIT_DIRECTORY_UNSAFE', report['failure_codes'])
                self.assertEqual(sentinel.read_bytes(), b'outside-sentinel')


if __name__ == '__main__':
    unittest.main()
