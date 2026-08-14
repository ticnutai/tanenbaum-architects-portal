from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mavat_app.config import ConfigStore


class AutomationEngineSettingsTests(unittest.TestCase):
    def test_safe_lazy_defaults_are_persistable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ConfigStore(Path(temporary))
            self.assertFalse(store.data["automation_engine_auto_connect"])
            self.assertTrue(store.data["automation_engine_keep_connected"])
            self.assertEqual(store.data["automation_engine_idle_minutes"], 20)

            store.data["automation_engine_auto_connect"] = True
            store.data["automation_engine_keep_connected"] = False
            store.data["automation_engine_idle_minutes"] = 7
            store.save()

            reloaded = ConfigStore(Path(temporary))
            self.assertTrue(reloaded.data["automation_engine_auto_connect"])
            self.assertFalse(reloaded.data["automation_engine_keep_connected"])
            self.assertEqual(reloaded.data["automation_engine_idle_minutes"], 7)


if __name__ == "__main__":
    unittest.main()
