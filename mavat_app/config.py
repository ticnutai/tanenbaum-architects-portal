from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

try:
    import keyring
    from keyring.errors import KeyringError
except ImportError:  # pragma: no cover - shown clearly in the UI
    keyring = None

    class KeyringError(Exception):
        pass


APP_NAME = "MavatAutomation"
KEYRING_SERVICE = "MavatAutomation.LoginProfiles"


def default_app_dir() -> Path:
    root = os.environ.get("APPDATA") or str(Path.home())
    return Path(root) / APP_NAME


@dataclass(slots=True)
class LoginProfile:
    id: str
    name: str
    username: str


class ConfigStore:
    """Stores non-secret settings as JSON and secrets in Windows Credential Manager."""

    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = Path(base_dir or default_app_dir())
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = self.base_dir / "config.json"
        self._session_passwords: dict[str, str] = {}
        self.data: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        defaults: dict[str, Any] = {
            "automations": [],
            "active_automation_id": "",
            "profiles": [],
            "last_data_file": "",
            "last_data_file_display_name": "",
            "workflow_file": "",
            "browser_profile_dir": str(self.base_dir / "chrome_profile"),
            "chrome_account_email": "",
            "chrome_debug_port": 9222,
        }
        if not self.config_path.exists():
            return defaults
        try:
            loaded = json.loads(self.config_path.read_text(encoding="utf-8"))
            defaults.update(loaded if isinstance(loaded, dict) else {})
        except (OSError, json.JSONDecodeError):
            pass
        return defaults

    def save(self) -> None:
        temp = self.config_path.with_suffix(".tmp")
        temp.write_text(
            json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temp.replace(self.config_path)

    def profiles(self) -> list[LoginProfile]:
        result: list[LoginProfile] = []
        for item in self.data.get("profiles", []):
            try:
                result.append(LoginProfile(**item))
            except TypeError:
                continue
        return result

    def upsert_profile(
        self,
        name: str,
        username: str,
        password: str,
        profile_id: str | None = None,
        persist_password: bool = True,
    ) -> LoginProfile:
        profile = LoginProfile(
            id=profile_id or uuid.uuid4().hex,
            name=name.strip(),
            username=username.strip(),
        )
        if not profile.name or not profile.username:
            raise ValueError("יש להזין שם פרופיל ושם משתמש/תעודת זהות")

        items = [p for p in self.profiles() if p.id != profile.id]
        items.append(profile)
        self.data["profiles"] = [asdict(p) for p in items]
        self.save()

        if password:
            self._session_passwords[profile.id] = password
            if persist_password:
                if keyring is None:
                    raise RuntimeError("הספרייה keyring אינה מותקנת; הסיסמה נשמרה להפעלה זו בלבד")
                try:
                    keyring.set_password(KEYRING_SERVICE, profile.id, password)
                except KeyringError as exc:
                    raise RuntimeError(
                        "לא ניתן לשמור ב-Windows Credential Manager; הסיסמה נשמרה להפעלה זו בלבד"
                    ) from exc
        return profile

    def get_password(self, profile_id: str) -> str:
        if profile_id in self._session_passwords:
            return self._session_passwords[profile_id]
        if keyring is None:
            return ""
        try:
            return keyring.get_password(KEYRING_SERVICE, profile_id) or ""
        except KeyringError:
            return ""

    def set_password(
        self, profile_id: str, password: str, persist_password: bool = True
    ) -> None:
        if not any(profile.id == profile_id for profile in self.profiles()):
            raise ValueError("פרופיל הכניסה אינו קיים")
        if not password:
            raise ValueError("יש להזין סיסמה חדשה")
        self._session_passwords[profile_id] = password
        if not persist_password:
            return
        if keyring is None:
            raise RuntimeError(
                "הספרייה keyring אינה מותקנת; הסיסמה נשמרה להפעלה זו בלבד"
            )
        try:
            keyring.set_password(KEYRING_SERVICE, profile_id, password)
        except KeyringError as exc:
            raise RuntimeError(
                "לא ניתן לשמור ב-Windows Credential Manager; הסיסמה נשמרה להפעלה זו בלבד"
            ) from exc

    def clear_password(self, profile_id: str) -> None:
        self._session_passwords.pop(profile_id, None)
        if keyring is None:
            return
        try:
            keyring.delete_password(KEYRING_SERVICE, profile_id)
        except KeyringError:
            pass

    def delete_profile(self, profile_id: str) -> None:
        self.data["profiles"] = [
            asdict(p) for p in self.profiles() if p.id != profile_id
        ]
        self._session_passwords.pop(profile_id, None)
        if keyring is not None:
            try:
                keyring.delete_password(KEYRING_SERVICE, profile_id)
            except (KeyringError, Exception):
                pass
        self.save()
