from __future__ import annotations

import json
import tempfile
from pathlib import Path

import web_app


with tempfile.TemporaryDirectory() as temp_dir:
    original_workflow_path = web_app.WORKFLOW_PATH
    original_log_path = web_app.LOG_PATH
    original_automation_dir = web_app.runtime.automation_dir
    original_store_data = web_app.runtime.store.data
    web_app.WORKFLOW_PATH = Path(temp_dir) / "workflow.json"
    web_app.LOG_PATH = Path(temp_dir) / "automation.log"
    web_app.runtime.automation_dir = Path(temp_dir) / "automations"
    web_app.runtime.automation_dir.mkdir()
    web_app.runtime.store.data = {
        **original_store_data,
        "automations": [{"id": "test", "name": "test", "status": "active"}],
        "active_automation_id": "test",
    }
    web_app.WORKFLOW_PATH.write_text(
        json.dumps(
            {
                "name": "test",
                "version": 1,
                "steps": [
                    {"name": "פתיחה", "type": "goto", "enabled": True},
                    {"name": "סיסמה", "type": "fill_secret", "enabled": True},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    web_app.LOG_PATH.write_text(
        "[2026-08-09 10:00:00] הצלחה: בדיקה\n[2026-08-09 10:01:00] שגיאה: בדיקה\n",
        encoding="utf-8",
    )
    web_app.runtime.workflow_path("test").write_text(
        web_app.WORKFLOW_PATH.read_text(encoding="utf-8"), encoding="utf-8"
    )
    web_app.runtime.log_path().write_text(
        web_app.LOG_PATH.read_text(encoding="utf-8"), encoding="utf-8"
    )
    try:
        client = web_app.app.test_client()
        assert client.get("/workflow").status_code == 302
        assert client.get("/workflow").headers["Location"] == "http://127.0.0.1:18474/workflow"
        assert client.get("/runs").status_code == 302
        assert client.get("/runs").headers["Location"] == "http://127.0.0.1:18474/logs"
        workflow = client.get("/api/workflow").get_json()
        assert len(workflow["workflow"]["steps"]) == 2
        assert client.post(
            "/api/steps/bulk", json={"indices": [0], "action": "pause"}
        ).status_code == 200
        assert client.post(
            "/api/steps", json={"position": 1, "step": {"name": "חדש", "type": "noop", "enabled": True}}
        ).status_code == 200
        assert client.post(
            "/api/steps/reorder", json={"order": [2, 1, 0]}
        ).status_code == 200
        logs = client.get("/api/logs").get_json()
        assert logs["summary"]["errors"] == 1
        assert logs["summary"]["success"] == 1
        assert client.get("/api/logs/export.csv").status_code == 200
    finally:
        web_app.WORKFLOW_PATH = original_workflow_path
        web_app.LOG_PATH = original_log_path
        web_app.runtime.automation_dir = original_automation_dir
        web_app.runtime.store.data = original_store_data

print("Web UI API tests: OK")
