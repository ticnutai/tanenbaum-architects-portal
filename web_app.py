from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, url_for
from werkzeug.utils import secure_filename

from mavat_app.config import ConfigStore
from mavat_app.data_loader import load_records
from mavat_app.recorder import BrowserRecorder
from mavat_app.workflow import RunCallbacks, WorkflowRunner, load_workflow, save_workflow


ROOT_DIR = Path(__file__).resolve().parent
WORKFLOW_PATH = ROOT_DIR / "workflow.json"
LOG_PATH = ROOT_DIR / "run_logs" / "automation.log"
MAVAT_URL = "https://www.gov.il/he/service/mvat"
WEB_PORT = 18473

app = Flask(__name__, template_folder="web/templates", static_folder="web/static")


class Runtime:
    def __init__(self) -> None:
        self.store = ConfigStore()
        self.lock = threading.RLock()
        self.recorder: BrowserRecorder | None = None
        self.recorder_thread: threading.Thread | None = None
        self.recording_state = "idle"
        self.recording_message = "ההקלטה כבויה"
        self.runner: WorkflowRunner | None = None
        self.runner_thread: threading.Thread | None = None
        self.run_state = "idle"
        self.run_message = "מוכן להפעלה"
        self.run_current_row = 0
        self.run_total_rows = 0
        self.manual_message = ""
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    def read_workflow(self) -> dict[str, Any]:
        with self.lock:
            return load_workflow(WORKFLOW_PATH)

    def write_workflow(self, workflow: dict[str, Any]) -> None:
        with self.lock:
            save_workflow(WORKFLOW_PATH, workflow)

    def log(self, message: str) -> None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.lock, LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] {message}\n")

    def recorded_step(self, step: dict[str, Any]) -> None:
        workflow = self.read_workflow()
        workflow.setdefault("steps", []).append(step)
        self.write_workflow(workflow)
        self.log(f"נקלט שלב: {step.get('name', step.get('type', ''))}")

    def start_recording(self) -> tuple[bool, str]:
        if self.recorder_thread and self.recorder_thread.is_alive():
            return True, "ההקלטה כבר פעילה"
        self.recording_state = "connecting"
        self.recording_message = "מתחבר ל-Chrome..."
        port = int(self.store.data.get("chrome_debug_port", 9222))

        def started(message: str) -> None:
            self.recording_state = "recording"
            self.recording_message = message
            self.log("הקלטת פעולות התחילה")

        def finished(message: str) -> None:
            self.recording_state = "error" if message.startswith("ההקלטה נכשלה") else "idle"
            self.recording_message = message
            self.log(message)
            self.recorder = None

        self.recorder = BrowserRecorder(
            port,
            on_log=self.log,
            on_step=self.recorded_step,
            on_started=started,
            on_finished=finished,
        )
        self.recorder_thread = threading.Thread(target=self.recorder.run, daemon=True)
        self.recorder_thread.start()
        return True, "מתחבר ל-Chrome לצורך הקלטה"

    def stop_recording(self) -> str:
        if self.recorder:
            self.recording_state = "stopping"
            self.recording_message = "עוצר הקלטה..."
            self.recorder.stop()
        return self.recording_message

    def run_status(self) -> dict[str, Any]:
        return {
            "state": self.run_state,
            "message": self.run_message,
            "current_row": self.run_current_row,
            "total_rows": self.run_total_rows,
            "manual_message": self.manual_message,
        }

    def start_run(self, profile_id: str, dry_run: bool) -> tuple[bool, str]:
        if self.runner_thread and self.runner_thread.is_alive():
            return False, "כבר מתבצעת הרצה"
        profiles = {profile.id: profile for profile in self.store.profiles()}
        profile = profiles.get(profile_id)
        if not profile:
            return False, "יש לבחור פרופיל כניסה"
        data_file = str(self.store.data.get("last_data_file") or "")
        if not data_file:
            return False, "יש לבחור קובץ Excel, CSV או Word"
        try:
            records = load_records(data_file)
        except Exception as exc:
            return False, f"טעינת הנתונים נכשלה: {exc}"
        if not records:
            return False, "קובץ הנתונים אינו מכיל רשומות"
        secrets = {item.id: self.store.get_password(item.id) for item in profiles.values()}
        self.run_state = "running"
        self.run_message = "בדיקת השלבים מתבצעת" if dry_run else "האוטומציה פועלת"
        self.run_current_row = 0
        self.run_total_rows = len(records)
        self.manual_message = ""

        def status(row: int, state: str, detail: str) -> None:
            self.run_current_row = row
            self.run_message = f"שורה {row}: {state}{' — ' + detail if detail else ''}"

        def manual(message: str) -> None:
            self.run_state = "manual"
            self.manual_message = message
            self.run_message = "ממתין לפעולה ידנית"
            self.log(f"נעצר ידנית: {message}")

        def finished(message: str) -> None:
            self.run_state = "error" if "נכשלה" in message or "שגיאה" in message else "idle"
            self.run_message = message
            self.manual_message = ""
            self.log(message)

        self.runner = WorkflowRunner(
            workflow=self.read_workflow(), records=records,
            username=profile.username, password=secrets.get(profile.id, ""),
            default_profile_id=profile.id, secrets_by_profile=secrets,
            browser_profile_dir=str(self.store.data["browser_profile_dir"]),
            chrome_debug_port=int(self.store.data.get("chrome_debug_port", 9222)),
            callbacks=RunCallbacks(log=self.log, status=status, manual=manual, finished=finished),
            dry_run=dry_run,
        )
        self.log(f"התחלת {'בדיקה' if dry_run else 'הרצה'} עבור {len(records)} רשומות")
        self.runner_thread = threading.Thread(target=self.runner.run, daemon=True)
        self.runner_thread.start()
        return True, self.run_message


runtime = Runtime()


def chrome_executable() -> str:
    candidates = [
        shutil.which("chrome.exe"),
        str(Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise FileNotFoundError("Google Chrome לא נמצא")


def parse_logs() -> list[dict[str, Any]]:
    if not LOG_PATH.exists():
        return []
    events: list[dict[str, Any]] = []
    pattern = re.compile(r"^\[(?P<timestamp>[^]]+)]\s*(?P<message>.*)$")
    for line_number, raw in enumerate(LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        match = pattern.match(raw)
        timestamp = match.group("timestamp") if match else ""
        message = match.group("message") if match else raw
        lower = message.lower()
        if any(word in message for word in ("שגיאה", "נכשלה", "חריגה")) or "error" in lower:
            status = "error"
        elif any(word in message for word in ("הצלחה", "הסתיימה", "הושלם")):
            status = "success"
        elif any(word in message for word in ("ידנית", "נעצר", "עוצר")):
            status = "manual"
        elif "נקלט שלב" in message:
            status = "recorded"
        else:
            status = "info"
        events.append({"id": line_number, "timestamp": timestamp, "message": message, "status": status})
    return list(reversed(events))


@app.get("/")
def index() -> Response:
    return redirect(url_for("workflow_page"))


@app.get("/workflow")
def workflow_page() -> str:
    return render_template("workflow.html", active="workflow")


@app.get("/runs")
def runs_page() -> str:
    return render_template("runs.html", active="runs")


@app.get("/api/workflow")
def api_workflow() -> Response:
    workflow = runtime.read_workflow()
    profiles = runtime.store.profiles()
    profile_status = {
        profile.id: {
            "name": profile.name,
            "username": profile.username,
            "has_password": bool(runtime.store.get_password(profile.id)),
        }
        for profile in profiles
    }
    for index, step in enumerate(workflow.get("steps", []), start=1):
        step["_index"] = index
        profile_id = str(step.get("credential_profile_id") or "")
        if step.get("type") == "fill_secret":
            step["_secret_status"] = "saved" if profile_id and profile_status.get(profile_id, {}).get("has_password") else "missing"
    return jsonify({"workflow": workflow, "profiles": profile_status})


@app.get("/api/settings")
def api_settings() -> Response:
    data_path = str(runtime.store.data.get("last_data_file") or "")
    preview: list[dict[str, Any]] = []
    error = ""
    if data_path:
        try:
            preview = load_records(data_path)[:5]
        except Exception as exc:
            error = str(exc)
    return jsonify({
        "data_file": data_path,
        "data_file_name": str(runtime.store.data.get("last_data_file_display_name") or (Path(data_path).name if data_path else "")),
        "preview": preview,
        "preview_count": len(preview),
        "error": error,
        "run": runtime.run_status(),
    })


@app.post("/api/settings/data-file")
def api_set_data_file() -> Response:
    path = Path(str((request.get_json(force=True) or {}).get("path") or ""))
    try:
        records = load_records(path)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"לא ניתן לקרוא את הקובץ: {exc}"}), 400
    runtime.store.data["last_data_file"] = str(path.resolve())
    runtime.store.data["last_data_file_display_name"] = path.name
    runtime.store.save()
    return jsonify({"ok": True, "name": path.name, "count": len(records), "preview": records[:5]})


@app.post("/api/settings/data-upload")
def api_upload_data_file() -> Response:
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"ok": False, "error": "לא התקבל קובץ"}), 400
    suffix = Path(uploaded.filename).suffix.lower()
    if suffix not in {".xlsx", ".csv", ".tsv", ".docx"}:
        return jsonify({"ok": False, "error": "סוג קובץ לא נתמך"}), 400
    upload_dir = runtime.store.base_dir / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    safe_name = secure_filename(Path(uploaded.filename).stem) or "clients"
    target = upload_dir / f"{uuid.uuid4().hex}_{safe_name}{suffix}"
    try:
        uploaded.save(target)
        records = load_records(target)
    except Exception as exc:
        target.unlink(missing_ok=True)
        return jsonify({"ok": False, "error": f"לא ניתן לקרוא את הקובץ: {exc}"}), 400
    runtime.store.data["last_data_file"] = str(target)
    runtime.store.data["last_data_file_display_name"] = uploaded.filename
    runtime.store.save()
    return jsonify({"ok": True, "name": uploaded.filename, "count": len(records), "preview": records[:5]})


@app.post("/api/run/start")
def api_run_start() -> Response:
    payload = request.get_json(force=True) or {}
    ok, message = runtime.start_run(str(payload.get("profile_id") or ""), bool(payload.get("dry_run", True)))
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@app.post("/api/run/stop")
def api_run_stop() -> Response:
    if runtime.runner:
        runtime.runner.stop()
        runtime.run_state = "stopping"
        runtime.run_message = "עוצר את ההרצה..."
    return jsonify({"ok": True, **runtime.run_status()})


@app.post("/api/run/continue")
def api_run_continue() -> Response:
    if not runtime.runner or runtime.run_state != "manual":
        return jsonify({"ok": False, "error": "אין פעולה ידנית שממתינה להמשך"}), 400
    runtime.runner.continue_after_manual()
    runtime.run_state = "running"
    runtime.run_message = "ממשיך בהרצה"
    runtime.manual_message = ""
    runtime.log("המשך לאחר פעולה ידנית")
    return jsonify({"ok": True})


@app.get("/api/run/status")
def api_run_status() -> Response:
    return jsonify(runtime.run_status())


@app.post("/api/steps")
def api_add_step() -> Response:
    payload = request.get_json(force=True) or {}
    step = payload.get("step") or {}
    if not step.get("name") or not step.get("type"):
        return jsonify({"ok": False, "error": "חסרים שם או סוג פעולה"}), 400
    workflow = runtime.read_workflow()
    steps = workflow.setdefault("steps", [])
    position = int(payload.get("position", len(steps)))
    position = max(0, min(position, len(steps)))
    steps.insert(position, step)
    runtime.write_workflow(workflow)
    return jsonify({"ok": True})


@app.put("/api/steps/<int:index>")
def api_update_step(index: int) -> Response:
    workflow = runtime.read_workflow()
    steps = workflow.get("steps", [])
    if index < 0 or index >= len(steps):
        return jsonify({"ok": False, "error": "השלב לא נמצא"}), 404
    updates = request.get_json(force=True) or {}
    allowed = {"name", "type", "scope", "target", "value", "timeout_seconds", "enabled", "credential_profile_id"}
    steps[index].update({key: value for key, value in updates.items() if key in allowed})
    runtime.write_workflow(workflow)
    return jsonify({"ok": True})


@app.post("/api/steps/bulk")
def api_bulk_steps() -> Response:
    payload = request.get_json(force=True) or {}
    indices = sorted({int(value) for value in payload.get("indices", [])})
    action = payload.get("action")
    workflow = runtime.read_workflow()
    steps = workflow.get("steps", [])
    valid = [index for index in indices if 0 <= index < len(steps)]
    if action == "delete":
        for index in reversed(valid):
            del steps[index]
    elif action in {"pause", "resume"}:
        for index in valid:
            steps[index]["enabled"] = action == "resume"
    else:
        return jsonify({"ok": False, "error": "פעולה לא מוכרת"}), 400
    runtime.write_workflow(workflow)
    return jsonify({"ok": True})


@app.post("/api/steps/reorder")
def api_reorder_steps() -> Response:
    order = [int(value) for value in (request.get_json(force=True) or {}).get("order", [])]
    workflow = runtime.read_workflow()
    steps = workflow.get("steps", [])
    if sorted(order) != list(range(len(steps))):
        return jsonify({"ok": False, "error": "סדר לא תקין"}), 400
    workflow["steps"] = [steps[index] for index in order]
    runtime.write_workflow(workflow)
    return jsonify({"ok": True})


@app.post("/api/credentials")
def api_save_credential() -> Response:
    payload = request.get_json(force=True) or {}
    password = str(payload.get("password") or "")
    if password != str(payload.get("confirm_password") or ""):
        return jsonify({"ok": False, "error": "הסיסמאות אינן זהות"}), 400
    try:
        profile = runtime.store.upsert_profile(
            str(payload.get("name") or ""),
            str(payload.get("username") or ""),
            password,
            profile_id=payload.get("profile_id") or None,
            persist_password=True,
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    step_index = payload.get("step_index")
    if step_index is not None:
        workflow = runtime.read_workflow()
        workflow["steps"][int(step_index)]["credential_profile_id"] = profile.id
        runtime.write_workflow(workflow)
    return jsonify({"ok": True, "profile_id": profile.id})


@app.delete("/api/credentials/<profile_id>/password")
def api_delete_credential_password(profile_id: str) -> Response:
    runtime.store.clear_password(profile_id)
    return jsonify({"ok": True})


@app.post("/api/recording/start")
def api_recording_start() -> Response:
    ok, message = runtime.start_recording()
    return jsonify({"ok": ok, "message": message})


@app.post("/api/recording/stop")
def api_recording_stop() -> Response:
    return jsonify({"ok": True, "message": runtime.stop_recording()})


@app.get("/api/recording/status")
def api_recording_status() -> Response:
    return jsonify({"state": runtime.recording_state, "message": runtime.recording_message})


@app.post("/api/chrome/open")
def api_open_chrome() -> Response:
    try:
        profile_dir = Path(runtime.store.data["browser_profile_dir"])
        profile_dir.mkdir(parents=True, exist_ok=True)
        port = int(runtime.store.data.get("chrome_debug_port", 9222))
        subprocess.Popen([
            chrome_executable(),
            f"--user-data-dir={profile_dir}",
            "--profile-directory=Default",
            f"--remote-debugging-port={port}",
            "--remote-allow-origins=*",
            "--new-window",
            MAVAT_URL,
        ], cwd=str(ROOT_DIR))
        runtime.log("Chrome נפתח בדף השירות של מבא״ת")
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/logs")
def api_logs() -> Response:
    events = parse_logs()
    status = request.args.get("status", "all")
    query = request.args.get("q", "").strip().lower()
    if status != "all":
        events = [event for event in events if event["status"] == status]
    if query:
        events = [event for event in events if query in event["message"].lower()]
    limit = min(2000, max(1, int(request.args.get("limit", 500))))
    all_events = parse_logs()
    summary = {
        "total": len(all_events),
        "errors": sum(event["status"] == "error" for event in all_events),
        "success": sum(event["status"] == "success" for event in all_events),
        "manual": sum(event["status"] == "manual" for event in all_events),
    }
    return jsonify({"events": events[:limit], "summary": summary})


@app.get("/api/console")
def api_console() -> Response:
    content = LOG_PATH.read_text(encoding="utf-8", errors="replace") if LOG_PATH.exists() else ""
    return jsonify({"content": content})


@app.get("/api/logs/export.csv")
def api_export_logs() -> Response:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=["timestamp", "status", "message"])
    writer.writeheader()
    for event in reversed(parse_logs()):
        writer.writerow({key: event[key] for key in writer.fieldnames})
    data = io.BytesIO(output.getvalue().encode("utf-8-sig"))
    return send_file(data, mimetype="text/csv", as_attachment=True, download_name="mavat_run_report.csv")


@app.post("/api/classic/open")
def api_open_classic() -> Response:
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    subprocess.Popen([str(pythonw), str(ROOT_DIR / "app.py")], cwd=str(ROOT_DIR))
    return jsonify({"ok": True})


def main() -> None:
    if "--no-browser" not in sys.argv:
        url = f"http://127.0.0.1:{WEB_PORT}/workflow"
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=WEB_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
