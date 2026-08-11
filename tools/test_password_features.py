from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

from mavat_app.config import ConfigStore
from mavat_app.ui import MavatApp, PasswordDialog
from mavat_app.workflow import RunCallbacks, WorkflowRunner


with tempfile.TemporaryDirectory() as temp_dir:
    store = ConfigStore(Path(temp_dir))
    profile = store.upsert_profile(
        "בדיקת סיסמה", "000000000", "temporary-test-secret", persist_password=True
    )
    assert store.get_password(profile.id) == "temporary-test-secret"
    store.clear_password(profile.id)
    assert store.get_password(profile.id) == ""
    store.delete_profile(profile.id)

callbacks = RunCallbacks(
    log=lambda _text: None,
    status=lambda _row, _status, _note: None,
    manual=lambda _text: None,
    finished=lambda _text: None,
)
runner = WorkflowRunner(
    {"steps": []},
    [{}],
    "user",
    "fallback",
    "profile-1",
    {"profile-2": "linked-secret"},
    "browser-profile",
    9223,
    callbacks,
    True,
)
page = MagicMock()
runner._execute_step(
    page,
    {
        "type": "fill_secret",
        "target": "סיסמה",
        "credential_profile_id": "profile-2",
    },
    {},
)
page.get_by_label.return_value.first.fill.assert_called_once_with(
    "linked-secret", timeout=30000
)

app = MavatApp()
app.workflow = {
    "steps": [
        {
            "name": "סיסמה",
            "type": "fill_secret",
            "enabled": True,
            "target": "סיסמה",
        }
    ]
}
app._refresh_steps()
values = app.steps_tree.item("0", "values")
assert "🔑" in str(values)
dialog = PasswordDialog(app, app.store, app.workflow["steps"][0])
dialog.update()
assert dialog.profile_var.get() == PasswordDialog.NEW_PROFILE
dialog.destroy()
app.destroy()

print("Password management tests: OK")
