from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import web_app


class RecordedStepDeduplicationTests(unittest.TestCase):
    def test_duplicate_is_suppressed_even_with_an_intervening_step(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            original_dir = web_app.runtime.automation_dir
            original_read = web_app.runtime.read_workflow
            original_write = web_app.runtime.write_workflow
            original_recent = web_app.runtime.recent_recorded_fingerprints
            workflow = {"name": "test", "steps": []}
            web_app.runtime.automation_dir = Path(temp_dir)
            web_app.runtime.read_workflow = lambda: workflow
            web_app.runtime.write_workflow = lambda value: workflow.update(value)
            web_app.runtime.recent_recorded_fingerprints = {}
            first = {"name": "שם", "type": "smart_fill", "target": "שם", "value": "יעקב"}
            second = {"name": "מחלקה", "type": "select_option", "target": "מחלקה", "value": "תכנון"}
            try:
                web_app.runtime.recorded_step(dict(first))
                web_app.runtime.recorded_step(dict(second))
                web_app.runtime.recorded_step(dict(first))
                self.assertEqual([step["name"] for step in workflow["steps"]], ["שם", "מחלקה"])
            finally:
                web_app.runtime.automation_dir = original_dir
                web_app.runtime.read_workflow = original_read
                web_app.runtime.write_workflow = original_write
                web_app.runtime.recent_recorded_fingerprints = original_recent


if __name__ == "__main__":
    unittest.main()
