import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("planning", Path(__file__).with_name("repair-scope-planning.py"))
planning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planning)


class ScopePlanningTests(unittest.TestCase):
    def test_even_component_label_is_not_lost_and_original_scope_is_preserved(self):
        labels = np.zeros((100, 100), np.int32)
        labels[40:64, 50] = 2
        defects = [{"x": 2, "y": 2, "width": 10, "height": 10, "kind": "missing_edge"}]
        result = planning.plan_scope_completion(labels, np.ones(labels.shape, bool), defects)
        self.assertEqual(result["suggestedRegions"], [
            {"x": 46, "y": 36, "width": 9, "height": 32, "unsupportedPixels": 24}])
        self.assertTrue(result["withinBudget"])
        self.assertEqual(result["summedArea"], 388)
        self.assertEqual(defects[0]["width"], 10)

    def test_protected_pixels_remain_unrepairable(self):
        labels = np.zeros((100, 100), np.int32)
        labels[40:64, 50] = 1
        permission = np.ones(labels.shape, bool)
        permission[50, 50] = False
        result = planning.plan_scope_completion(labels, permission, [])
        self.assertFalse(result["canCoverBlockingRuns"])
        self.assertEqual(result["blockedPixels"], 1)

    def test_budget_counts_existing_rectangles_not_just_new_regions(self):
        labels = np.zeros((100, 100), np.int32)
        labels[60:84, 70] = 1
        result = planning.plan_scope_completion(labels, np.ones(labels.shape, bool),
            [{"x": 0, "y": 0, "width": 50, "height": 50}])
        self.assertFalse(result["withinBudget"])
        self.assertEqual(result["summedArea"], 2788)

    def test_covered_long_run_needs_no_new_region(self):
        labels = np.zeros((100, 100), np.int32)
        labels[40:64, 50] = 1
        result = planning.plan_scope_completion(labels, np.ones(labels.shape, bool),
            [{"x": 40, "y": 30, "width": 20, "height": 40}])
        self.assertEqual(result["suggestedRegions"], [])


if __name__ == "__main__":
    unittest.main()
