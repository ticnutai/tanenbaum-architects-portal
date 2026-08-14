from __future__ import annotations

import unittest
from unittest.mock import patch

import web_app


class RunProfileRequirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_read_workflow = web_app.runtime.read_workflow
        self.original_runner_thread = web_app.runtime.runner_thread
        web_app.runtime.runner_thread = None

    def tearDown(self) -> None:
        web_app.runtime.read_workflow = self.original_read_workflow
        web_app.runtime.runner_thread = self.original_runner_thread

    def test_local_workflow_does_not_require_login_profile(self) -> None:
        web_app.runtime.read_workflow = lambda: {
            "name": "local",
            "steps": [{"name": "פתיחה", "type": "goto", "scope": "once", "enabled": True}],
        }
        with patch.object(web_app.WorkflowRunner, "run", return_value=None):
            ok, message = web_app.runtime.start_run("", True)
            web_app.runtime.runner_thread.join(timeout=2)
        self.assertTrue(ok, message)

    def test_secret_step_still_requires_login_profile(self) -> None:
        web_app.runtime.read_workflow = lambda: {
            "name": "secret",
            "steps": [{"name": "סיסמה", "type": "fill_secret", "scope": "once", "enabled": True}],
        }
        ok, message = web_app.runtime.start_run("", True)
        self.assertFalse(ok)
        self.assertIn("פרופיל כניסה", message)

    def test_recorder_accepts_hosts_from_active_workflow(self) -> None:
        web_app.runtime.read_workflow = lambda: {
            "name": "local",
            "steps": [{"name": "פתיחה", "type": "goto", "value": "http://127.0.0.1:18474/test"}],
        }
        endpoint = type("Endpoint", (), {
            "provider": "browseros", "connected": True, "pages": [], "cdp_port": 9101,
        })()
        with (
            patch.object(web_app.runtime, "browser_endpoint", return_value=(endpoint, [endpoint])),
            patch.object(web_app, "open_browseros_page"),
            patch.object(web_app, "BrowserRecorder") as recorder,
        ):
            ok, message = web_app.runtime.start_recording()
        self.assertTrue(ok, message)
        self.assertIn("127.0.0.1:18474", recorder.call_args.kwargs["target_fragments"])
        web_app.runtime.recorder_thread = None


if __name__ == "__main__":
    unittest.main()
