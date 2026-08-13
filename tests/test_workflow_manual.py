from __future__ import annotations

import threading
import time
import unittest

from mavat_app.workflow import RunCallbacks, WorkflowRunner


class _Page:
    def __init__(self, url: str) -> None:
        self.url = url
        self.context = type("Context", (), {"pages": [self]})()


class _ReplayPage(_Page):
    def __init__(self, url: str, frame_urls: list[str] | None = None) -> None:
        super().__init__(url)
        self.main_frame = type("Frame", (), {"url": url})()
        self.frames = [self.main_frame] + [type("Frame", (), {"url": item})() for item in (frame_urls or [])]
        self.goto_calls: list[str] = []

    def goto(self, url: str, **_kwargs: object) -> None:
        self.goto_calls.append(url)
        self.url = url


class SecureAuthenticationTests(unittest.TestCase):
    def test_secure_auth_resumes_when_mavat_page_appears(self) -> None:
        messages: list[str] = []
        page = _Page("https://login.gov.il/nidp/saml2/sso?sid=0")
        runner = WorkflowRunner(
            workflow={"steps": []}, records=[{}], username="", password="",
            default_profile_id="", secrets_by_profile={}, browser_profile_dir="",
            chrome_debug_port=9223,
            callbacks=RunCallbacks(
                log=messages.append, status=lambda *_: None, manual=messages.append,
                finished=lambda *_: None,
            ),
        )

        def complete_login() -> None:
            time.sleep(0.35)
            page.url = "https://plan.mavat.moin.gov.il/mavatPM/Default.aspx"

        threading.Thread(target=complete_login, daemon=True).start()
        started = time.monotonic()
        runner._wait_manual(
            "נדרש אימות", page=page,
            resume_when={
                "url_not_contains": "login.gov.il",
                "url_contains_any": ["plan.mavat.moin.gov.il"],
            },
            timeout_seconds=10,
        )

        self.assertLess(time.monotonic() - started, 3)
        self.assertTrue(any("ממשיך אוטומטית" in message for message in messages))


class RecordedPageReplayTests(unittest.TestCase):
    def runner(self, messages: list[str]) -> WorkflowRunner:
        return WorkflowRunner(
            workflow={"steps": []}, records=[{}], username="", password="",
            default_profile_id="", secrets_by_profile={}, browser_profile_dir="",
            chrome_debug_port=9223,
            callbacks=RunCallbacks(
                log=messages.append, status=lambda *_: None, manual=messages.append,
                finished=lambda *_: None,
            ),
        )

    def test_replay_navigates_from_blank_page_to_recorded_page(self) -> None:
        messages: list[str] = []
        page = _ReplayPage("about:blank")
        expected = "https://example.test/search?q=recorded"

        self.runner(messages)._prepare_page_for_step(page, {"page_url": expected}, 5000)

        self.assertEqual(page.goto_calls, [expected])
        self.assertTrue(any("ניווט מקדים" in message for message in messages))

    def test_replay_does_not_replace_page_when_recorded_url_is_an_iframe(self) -> None:
        page = _ReplayPage("https://example.test/host", ["https://frame.test/form"])

        self.runner([])._prepare_page_for_step(
            page, {"page_url": "https://frame.test/form"}, 5000
        )

        self.assertEqual(page.goto_calls, [])

    def test_missing_optional_banner_does_not_fail_the_run(self) -> None:
        messages: list[str] = []
        runner = self.runner(messages)

        def missing(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("banner not present")

        runner._smart_action = missing  # type: ignore[method-assign]
        page = _ReplayPage("https://example.test/")
        result = runner._execute_step(page, {
            "type": "smart_click",
            "name": "לחיצה: קבל הכל",
            "target": "קבל הכל",
            "optional": True,
        }, {})

        self.assertIs(result, page)
        self.assertTrue(any("האופציונלית" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
