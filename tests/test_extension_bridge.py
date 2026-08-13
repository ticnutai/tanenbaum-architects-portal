from __future__ import annotations

import json
import time
import unittest

from mavat_app.config import ConfigStore
from mavat_app.extension_bridge import ExtensionBridge, extension_id_from_origin, token_digest


ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


class ExtensionBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        from pathlib import Path

        self.temporary = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.temporary.name))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_pairing_stores_only_token_digest(self) -> None:
        bridge = ExtensionBridge(self.store)
        pairing = bridge.create_pairing_code()
        token = bridge.pair(ORIGIN, pairing["pairing_code"])

        self.assertTrue(bridge.authenticate(ORIGIN, token))
        persisted = json.loads(self.store.config_path.read_text(encoding="utf-8"))
        saved = persisted["extension_bridge_tokens"][0]
        self.assertEqual(saved["extension_id"], "abcdefghijklmnopabcdefghijklmnop")
        self.assertEqual(saved["token_hash"], token_digest(token))
        self.assertNotIn(token, self.store.config_path.read_text(encoding="utf-8"))
        self.assertEqual(bridge.status(include_code=True)["pairing_code"], "")

    def test_pairing_rejects_wrong_origin_code_and_expiry(self) -> None:
        bridge = ExtensionBridge(self.store)
        pairing = bridge.create_pairing_code()
        with self.assertRaisesRegex(ValueError, "מקור"):
            bridge.pair("https://example.com", pairing["pairing_code"])
        wrong = "999999" if pairing["pairing_code"] != "999999" else "000000"
        with self.assertRaisesRegex(ValueError, "שגוי"):
            bridge.pair(ORIGIN, wrong)

        bridge.pairing.expires_at = time.time() - 1
        with self.assertRaisesRegex(ValueError, "פג"):
            bridge.pair(ORIGIN, pairing["pairing_code"])

    def test_revoke_and_origin_validation(self) -> None:
        bridge = ExtensionBridge(self.store)
        code = bridge.create_pairing_code()["pairing_code"]
        token = bridge.pair(ORIGIN, code)
        self.assertTrue(extension_id_from_origin(ORIGIN))
        self.assertFalse(extension_id_from_origin("chrome-extension://invalid"))
        self.assertFalse(bridge.authenticate(ORIGIN, "wrong"))

        bridge.revoke_all()
        self.assertFalse(bridge.authenticate(ORIGIN, token))
        self.assertEqual(bridge.status()["paired_count"], 0)


if __name__ == "__main__":
    unittest.main()
