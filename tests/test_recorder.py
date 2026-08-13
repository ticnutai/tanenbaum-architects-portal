from __future__ import annotations

import unittest

from mavat_app.recorder import BrowserRecorder


class RecorderStepTests(unittest.TestCase):
    def test_regular_field_keeps_recorded_value(self) -> None:
        step = BrowserRecorder._to_step({
            "kind": "fill",
            "label": "מספר תוכנית",
            "value": "123-456",
            "url": "https://plan.mavat.moin.gov.il/form",
            "selectors": [{"strategy": "label", "value": "מספר תוכנית", "score": 98}],
        })
        self.assertEqual(step["type"], "smart_fill")
        self.assertEqual(step["value"], "123-456")

    def test_password_never_enters_workflow_step(self) -> None:
        step = BrowserRecorder._to_step({
            "kind": "fill",
            "label": "סיסמה",
            "secret": True,
            "secret_value": "must-not-appear",
            "url": "https://login.gov.il/",
            "selectors": [{"strategy": "label", "value": "סיסמה", "score": 98}],
        })
        self.assertEqual(step["type"], "fill_secret")
        self.assertEqual(step["value"], "")
        self.assertNotIn("secret_value", step)
        self.assertNotIn("must-not-appear", repr(step))

    def test_toggle_is_replayable_as_smart_click(self) -> None:
        step = BrowserRecorder._to_step({
            "kind": "toggle",
            "label": "אני מאשר",
            "checked": True,
            "url": "https://plan.mavat.moin.gov.il/form",
            "selectors": [{"strategy": "label", "value": "אני מאשר", "score": 98}],
        })
        self.assertEqual(step["type"], "smart_click")

    def test_cookie_banner_close_is_recorded_as_optional(self) -> None:
        step = BrowserRecorder._to_step({
            "kind": "click",
            "name": "קבל הכל",
            "overlay": True,
            "url": "https://example.test/",
            "selectors": [{"strategy": "role", "role": "button", "value": "קבל הכל", "score": 96}],
        })
        self.assertTrue(step["optional"])

    def test_regular_close_button_is_not_automatically_optional(self) -> None:
        step = BrowserRecorder._to_step({
            "kind": "click",
            "name": "סגור",
            "overlay": False,
            "url": "https://example.test/",
            "selectors": [{"strategy": "role", "role": "button", "value": "סגור", "score": 96}],
        })
        self.assertFalse(step["optional"])


if __name__ == "__main__":
    unittest.main()
