from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from mavat_app.ui import MavatApp


with tempfile.TemporaryDirectory() as temp_dir:
    app = MavatApp()
    app.workflow_path = Path(temp_dir) / "workflow.json"
    app.workflow = {
        "name": "test",
        "version": 1,
        "steps": [
            {"name": "A", "type": "noop", "enabled": True},
            {"name": "B", "type": "noop", "enabled": True},
            {"name": "C", "type": "noop", "enabled": True},
        ],
    }
    app._refresh_steps()
    app.steps_tree.selection_set("0", "1")
    app._set_selected_enabled(False)
    assert not app.workflow["steps"][0]["enabled"]
    assert not app.workflow["steps"][1]["enabled"]

    app._move_step(1)
    assert [step["name"] for step in app.workflow["steps"]] == ["C", "A", "B"]

    app.steps_tree.selection_set("1", "2")
    with patch("mavat_app.ui.messagebox.askyesno", return_value=True):
        app._delete_steps()
    assert [step["name"] for step in app.workflow["steps"]] == ["C"]
    app.destroy()

print("Multi-select step editor test: OK")
