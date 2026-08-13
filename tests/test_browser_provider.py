from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mavat_app.browser_provider import (
    BrowserEndpoint,
    browseros_connection_settings,
    select_browser_endpoint,
)


class BrowserProviderTests(unittest.TestCase):
    def test_reads_dynamic_browseros_ports(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(
                json.dumps({"ports": {"cdp": 19101, "proxy": 19001, "server": 19200}}),
                encoding="utf-8",
            )
            cdp_port, mcp_url = browseros_connection_settings(path)
        self.assertEqual(cdp_port, 19101)
        self.assertEqual(mcp_url, "http://127.0.0.1:19001/mcp")

    def test_older_browseros_config_falls_back_to_server_port(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(
                json.dumps({"ports": {"cdp": 19101, "server": 19200}}),
                encoding="utf-8",
            )
            _, mcp_url = browseros_connection_settings(path)
        self.assertEqual(mcp_url, "http://127.0.0.1:19200/mcp")

    @patch("mavat_app.browser_provider._browseros_mcp_healthy", return_value=True)
    @patch("mavat_app.browser_provider._probe_cdp")
    def test_auto_prefers_browseros(self, probe, _health) -> None:
        probe.return_value = BrowserEndpoint("browseros", "BrowserOS", True, 9101, pages=[])
        selected, candidates = select_browser_endpoint("auto")
        self.assertEqual(selected.provider, "browseros")
        self.assertEqual(len(candidates), 2)
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(candidates[1].error, "לא נבדק — ספק הגלישה הפעיל מחובר")

    @patch("mavat_app.browser_provider._browseros_mcp_healthy", return_value=False)
    @patch("mavat_app.browser_provider._probe_cdp")
    def test_auto_falls_back_to_chrome_when_browseros_is_unhealthy(self, probe, _health) -> None:
        probe.side_effect = [
            BrowserEndpoint("browseros", "BrowserOS", True, 9101, pages=[]),
            BrowserEndpoint("chrome", "Google Chrome", True, 9223, pages=[]),
        ]
        selected, _ = select_browser_endpoint("auto")
        self.assertEqual(selected.provider, "chrome")

    @patch("mavat_app.browser_provider._browseros_mcp_healthy", return_value=True)
    @patch("mavat_app.browser_provider._probe_cdp")
    def test_explicit_chrome_keeps_existing_path(self, probe, _health) -> None:
        probe.return_value = BrowserEndpoint("chrome", "Google Chrome", True, 9223, pages=[])
        selected, _ = select_browser_endpoint("chrome")
        self.assertEqual(selected.provider, "chrome")
        self.assertEqual(probe.call_count, 1)
        _health.assert_not_called()


if __name__ == "__main__":
    unittest.main()
