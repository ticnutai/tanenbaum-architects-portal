from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from mavat_app.config import ConfigStore


EXTENSION_ORIGIN_RE = re.compile(r"^chrome-extension://([a-p]{32})$")
PAIRING_TTL_SECONDS = 10 * 60


def extension_id_from_origin(origin: str) -> str:
    match = EXTENSION_ORIGIN_RE.fullmatch(origin.strip())
    return match.group(1) if match else ""


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass(slots=True)
class PairingSession:
    code: str
    expires_at: float

    @property
    def active(self) -> bool:
        return bool(self.code) and self.expires_at > time.time()


class ExtensionBridge:
    """Pairs the local browser extension without storing its bearer token."""

    def __init__(self, store: ConfigStore) -> None:
        self.store = store
        self.pairing = PairingSession("", 0.0)

    def paired_extensions(self) -> list[dict[str, Any]]:
        items = self.store.data.get("extension_bridge_tokens") or []
        return [item for item in items if isinstance(item, dict)]

    def status(self, *, include_code: bool = False) -> dict[str, Any]:
        active = self.pairing.active
        result: dict[str, Any] = {
            "paired_count": len(self.paired_extensions()),
            "pairing_active": active,
            "pairing_expires_at": (
                datetime.fromtimestamp(self.pairing.expires_at).isoformat(timespec="seconds")
                if active
                else ""
            ),
        }
        if include_code:
            result["pairing_code"] = self.pairing.code if active else ""
        return result

    def create_pairing_code(self) -> dict[str, Any]:
        self.pairing = PairingSession(
            f"{secrets.randbelow(1_000_000):06d}",
            time.time() + PAIRING_TTL_SECONDS,
        )
        return self.status(include_code=True)

    def pair(self, origin: str, code: str) -> str:
        extension_id = extension_id_from_origin(origin)
        if not extension_id:
            raise ValueError("מקור התוסף אינו תקין")
        if not self.pairing.active:
            raise ValueError("קוד החיבור פג; צור קוד חדש בתוכנה")
        if not hmac.compare_digest(self.pairing.code, str(code).strip()):
            raise ValueError("קוד החיבור שגוי")

        token = secrets.token_urlsafe(32)
        items = [
            item
            for item in self.paired_extensions()
            if str(item.get("extension_id") or "") != extension_id
        ]
        items.append(
            {
                "extension_id": extension_id,
                "token_hash": token_digest(token),
                "paired_at": datetime.now().isoformat(timespec="seconds"),
            }
        )
        self.store.data["extension_bridge_tokens"] = items
        self.store.save()
        self.pairing = PairingSession("", 0.0)
        return token

    def authenticate(self, origin: str, token: str) -> bool:
        extension_id = extension_id_from_origin(origin)
        if not extension_id or not token:
            return False
        digest = token_digest(token)
        return any(
            hmac.compare_digest(str(item.get("extension_id") or ""), extension_id)
            and hmac.compare_digest(str(item.get("token_hash") or ""), digest)
            for item in self.paired_extensions()
        )

    def revoke_all(self) -> None:
        self.store.data["extension_bridge_tokens"] = []
        self.store.save()
        self.pairing = PairingSession("", 0.0)
