from __future__ import annotations

import csv
import io
import json
import os
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
import urllib.error
import urllib.request
import websocket
from datetime import datetime
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from flask import Flask, Response, jsonify, redirect, request, send_file, send_from_directory
from flask_sock import Sock
from werkzeug.utils import secure_filename

from mavat_app.config import ConfigStore
from mavat_app.browser_provider import (
    BrowserEndpoint,
    open_browseros_page,
    select_browser_endpoint,
)
from mavat_app.cdp import CdpConnection, CdpEvent, page_targets
from mavat_app.data_loader import load_records
from mavat_app.extension_bridge import ExtensionBridge, extension_id_from_origin
from mavat_app.recorder import BrowserRecorder
from mavat_app.workflow import RunCallbacks, WorkflowRunner, load_workflow, save_workflow


ROOT_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
DATA_DIR = Path(os.environ.get("MAVAT_DATA_DIR", ROOT_DIR))
WORKFLOW_PATH = ROOT_DIR / "workflow.json"
LOG_PATH = DATA_DIR / "run_logs" / "automation.log"
MAVAT_URL = "https://www.gov.il/he/service/mvat"
WEB_PORT = int(os.environ.get("MAVAT_WEB_PORT", "18473"))

app = Flask(__name__, template_folder="web/templates", static_folder="web/static")
sock = Sock(app)
FRONTEND_DIR = Path(os.environ.get("MAVAT_FRONTEND_DIR", ROOT_DIR / "dist-electron"))


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
        self.current_step = 0
        self.current_step_name = ""
        self.current_step_action = ""
        self.current_step_target = ""
        self.run_started_at = ""
        self.run_paused_from = ""
        self.last_error: dict[str, Any] = {}
        self.chrome_import_thread: threading.Thread | None = None
        self.chrome_import_state = "idle"
        self.chrome_import_message = "טרם בוצע ייבוא מ-Chrome"
        self.chrome_import_current = 0
        self.chrome_import_total = 0
        self.chrome_import_warnings: list[str] = []
        self.chrome_console_events: list[dict[str, Any]] = []
        self.chrome_console_monitor_thread: threading.Thread | None = None
        self.chrome_preview_thread: threading.Thread | None = None
        self.chrome_preview_process: subprocess.Popen[bytes] | None = None
        self.chrome_preview_frame: bytes = b""
        self.chrome_preview_enabled = True
        self.chrome_preview_target_id = ""
        self.chrome_preview_url = ""
        self.chrome_preview_title = ""
        self.chrome_preview_error = ""
        self.chrome_preview_updated_at = ""
        self.chrome_preview_frames = 0
        self.chrome_interaction_lock = threading.Lock()
        self.recorder_suppressed_until = 0.0
        self.last_recorded_fingerprint = ""
        self.last_recorded_at = 0.0
        self.event_listeners: list[queue.Queue[dict[str, Any]]] = []
        self.extension_live_connections: dict[str, int] = {}
        self.workflow_revision = 0
        self.extension_bridge = ExtensionBridge(self.store)
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.automation_dir = self.store.base_dir / "automations"
        self.automation_dir.mkdir(parents=True, exist_ok=True)
        self.ensure_default_automation()

    def ensure_default_automation(self) -> None:
        automations = self.store.data.get("automations")
        if not isinstance(automations, list) or not automations:
            automations = [{
                "id": "mavat",
                "name": "אוטומציית מבא״ת",
                "description": "כניסה למבא״ת, מילוי נתונים וביצוע שלבי העבודה באתר",
                "status": "active",
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }]
            self.store.data["automations"] = automations
            self.store.data["active_automation_id"] = "mavat"
            self.store.save()
        active_id = str(self.store.data.get("active_automation_id") or "")
        if not any(str(item.get("id")) == active_id for item in automations):
            self.store.data["active_automation_id"] = str(automations[0]["id"])
            self.store.save()
        target = self.automation_dir / "mavat.json"
        if not target.exists():
            source = load_workflow(WORKFLOW_PATH)
            save_workflow(target, source)

    def extension_status(self, *, include_code: bool = False) -> dict[str, Any]:
        result = self.extension_bridge.status(include_code=include_code)
        with self.lock:
            result["live_count"] = sum(self.extension_live_connections.values())
        return result

    def automations(self) -> list[dict[str, Any]]:
        return list(self.store.data.get("automations") or [])

    def active_automation_id(self) -> str:
        return str(self.store.data.get("active_automation_id") or "mavat")

    def active_automation(self) -> dict[str, Any]:
        active_id = self.active_automation_id()
        return next((item for item in self.automations() if str(item.get("id")) == active_id), self.automations()[0])

    def active_data_file(self) -> tuple[str, str]:
        automation = self.active_automation()
        is_migrated_default = str(automation.get("id")) == "mavat"
        path = str(automation.get("data_file") or (self.store.data.get("last_data_file") if is_migrated_default else "") or "")
        name = str(automation.get("data_file_name") or (self.store.data.get("last_data_file_display_name") if is_migrated_default else "") or "")
        return path, name

    def set_active_data_file(self, path: str, display_name: str) -> None:
        automation = self.active_automation()
        automation["data_file"] = path
        automation["data_file_name"] = display_name
        self.store.save()

    def log_path(self) -> Path:
        return LOG_PATH.parent / f"{self.active_automation_id()}.log"

    def chrome_import_status(self) -> dict[str, Any]:
        return {
            "state": self.chrome_import_state,
            "message": self.chrome_import_message,
            "current": self.chrome_import_current,
            "total": self.chrome_import_total,
            "warnings": self.chrome_import_warnings[-10:],
        }

    def chrome_cdp_status(self) -> dict[str, Any]:
        selected, candidates = self.browser_endpoint()
        result = selected.to_dict()
        result.update({
            "port": selected.cdp_port,
            "profile_directory": (
                "BrowserOS"
                if selected.provider == "browseros"
                else str(self.store.data.get("chrome_profile_directory") or "Default")
            ),
            "console_events": len(self.chrome_console_events),
            "preview": self.chrome_preview_status(),
            "candidates": [item.to_dict() for item in candidates],
            "fallback_available": any(
                item.connected and item.provider != selected.provider for item in candidates
            ),
        })
        return result

    def browser_endpoint(self) -> tuple[BrowserEndpoint, list[BrowserEndpoint]]:
        return select_browser_endpoint(
            preferred=str(self.store.data.get("browser_provider") or "auto"),
            chrome_port=int(self.store.data.get("chrome_debug_port", 9223)),
            browseros_cdp_port=int(self.store.data.get("browseros_cdp_port") or 0),
            browseros_mcp_url=str(self.store.data.get("browseros_mcp_url") or ""),
        )

    def browser_debug_port(self) -> int:
        selected, _ = self.browser_endpoint()
        return selected.cdp_port

    def chrome_preview_status(self) -> dict[str, Any]:
        return {
            "enabled": self.chrome_preview_enabled,
            "available": bool(self.chrome_preview_frame),
            "target_id": self.chrome_preview_target_id,
            "url": self.chrome_preview_url,
            "title": self.chrome_preview_title,
            "error": self.chrome_preview_error,
            "updated_at": self.chrome_preview_updated_at,
            "frames": self.chrome_preview_frames,
        }

    def stop_chrome_preview_process(self) -> None:
        """Stop the raw-CDP preview worker process tree as one unit."""
        process = self.chrome_preview_process
        self.chrome_preview_process = None
        if not process or process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
            return
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()

    def ensure_chrome_preview(self) -> None:
        if self.chrome_preview_thread and self.chrome_preview_thread.is_alive():
            return

        def monitor() -> None:
            while True:
                if not self.chrome_preview_enabled:
                    time.sleep(0.5)
                    continue
                try:
                    self.chrome_preview_error = "מתחבר לדפדפן האוטומציה..."
                    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                    selected_target = self.chrome_preview_target_id
                    process = subprocess.Popen(
                        [sys.executable, "-m", "mavat_app.preview_worker",
                         str(self.browser_debug_port()), selected_target],
                        cwd=str(ROOT_DIR), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                        creationflags=creation_flags,
                    )
                    self.chrome_preview_process = process
                    assert process.stdout is not None
                    while process.poll() is None and self.chrome_preview_enabled:
                        header_line = process.stdout.readline()
                        if not header_line:
                            break
                        header = json.loads(header_line.decode("utf-8"))
                        length = int(header.get("length") or 0)
                        frame = process.stdout.read(length) if length else b""
                        if length:
                            process.stdout.read(1)
                        with self.lock:
                            if frame:
                                self.chrome_preview_frame = frame
                                self.chrome_preview_frames += 1
                                self.chrome_preview_updated_at = datetime.now().isoformat(timespec="seconds")
                            self.chrome_preview_target_id = str(header.get("target_id") or self.chrome_preview_target_id)
                            self.chrome_preview_url = str(header.get("url") or self.chrome_preview_url)
                            self.chrome_preview_title = str(header.get("title") or self.chrome_preview_title)
                            self.chrome_preview_error = str(header.get("error") or "")
                except Exception as exc:
                    self.chrome_preview_error = f"חיבור CDP נותק: {exc}"
                finally:
                    self.stop_chrome_preview_process()
                time.sleep(1.0)

        self.chrome_preview_thread = threading.Thread(target=monitor, daemon=True)
        self.chrome_preview_thread.start()

    def ensure_chrome_console_monitor(self) -> None:
        if self.chrome_console_monitor_thread and self.chrome_console_monitor_thread.is_alive():
            return

        def monitor() -> None:
            port = self.browser_debug_port()
            workers: dict[str, threading.Thread] = {}

            def append_event(level: str, text: str, page_url: str) -> None:
                event = {
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "level": level,
                    "text": str(text).replace("\x00", "")[:3000],
                    "url": str(page_url)[:1000],
                }
                with self.lock:
                    self.chrome_console_events.append(event)
                    del self.chrome_console_events[:-500]
                self.publish_event("chrome-console", **event)

            def watch(target: dict[str, Any]) -> None:
                connection: CdpConnection | None = None
                url = str(target.get("url") or "")

                def handle(event: CdpEvent) -> None:
                    if event.method == "Runtime.consoleAPICalled":
                        args = event.params.get("args") or []
                        text = " ".join(
                            str(arg.get("value") if "value" in arg else arg.get("description") or "")
                            for arg in args
                        )
                        append_event(str(event.params.get("type") or "log"), text, url)
                    elif event.method == "Runtime.exceptionThrown":
                        details = event.params.get("exceptionDetails") or {}
                        append_event(
                            "pageerror",
                            str((details.get("exception") or {}).get("description") or details.get("text") or "שגיאת JavaScript"),
                            url,
                        )
                    elif event.method == "Log.entryAdded":
                        entry = event.params.get("entry") or {}
                        append_event(str(entry.get("level") or "log"), str(entry.get("text") or ""), str(entry.get("url") or url))

                try:
                    connection = CdpConnection(str(target["webSocketDebuggerUrl"]), on_event=handle)
                    connection.request("Runtime.enable")
                    connection.request("Log.enable")
                    while True:
                        try:
                            connection.pump_once()
                        except websocket.WebSocketTimeoutException:
                            continue
                except Exception as exc:
                    self.log(f"ניטור Raw CDP Console נותק: {exc}")
                finally:
                    if connection:
                        connection.close()

            while True:
                try:
                    targets = [
                        target
                        for target in page_targets(port)
                        if str(target.get("url") or "").startswith("http")
                    ]
                    active_ids = {str(target.get("id") or "") for target in targets}
                    for target_id, thread in list(workers.items()):
                        if target_id not in active_ids or not thread.is_alive():
                            workers.pop(target_id, None)
                    for target in targets:
                        target_id = str(target.get("id") or "")
                        if not target_id or target_id in workers:
                            continue
                        thread = threading.Thread(target=watch, args=(target,), daemon=True)
                        workers[target_id] = thread
                        thread.start()
                except Exception:
                    pass
                time.sleep(0.75)

        self.chrome_console_monitor_thread = threading.Thread(target=monitor, daemon=True)
        self.chrome_console_monitor_thread.start()

    def chrome_interact(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.chrome_interaction_lock:
            request_id = uuid.uuid4().hex
            command = {**payload, "id": request_id}
            creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            result = subprocess.run(
                [sys.executable, "-m", "mavat_app.interactive_browser",
                 str(self.browser_debug_port()), self.chrome_preview_target_id],
                cwd=str(ROOT_DIR), input=json.dumps(command, ensure_ascii=False) + "\n",
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", timeout=18,
                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                creationflags=creation_flags,
            )
            lines = [line for line in (result.stdout or "").splitlines() if line.strip()]
            if not lines:
                raise RuntimeError((result.stderr or "").strip() or "מנוע השליטה בדפדפן לא החזיר תשובה")
            response = json.loads(lines[-1])
            if response.get("id") != request_id:
                raise RuntimeError("התקבלה תשובה לא תואמת ממנוע הדפדפן")
            return response

    def workflow_path(self, automation_id: str | None = None) -> Path:
        safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", automation_id or self.active_automation_id())
        return self.automation_dir / f"{safe_id or 'mavat'}.json"

    def activate_automation(self, automation_id: str) -> dict[str, Any]:
        automation = next((item for item in self.automations() if str(item.get("id")) == automation_id), None)
        if not automation:
            raise ValueError("האוטומציה לא נמצאה")
        if automation_id == self.active_automation_id():
            return automation
        if self.runner_thread and self.runner_thread.is_alive():
            raise RuntimeError("לא ניתן להחליף אוטומציה בזמן הרצה")
        if self.recorder_thread and self.recorder_thread.is_alive():
            raise RuntimeError("יש לעצור את ההקלטה לפני החלפת אוטומציה")
        self.store.data["active_automation_id"] = automation_id
        self.store.save()
        self.log(f"נבחרה אוטומציה: {automation.get('name', automation_id)}")
        return automation

    def read_workflow(self) -> dict[str, Any]:
        with self.lock:
            workflow = load_workflow(self.workflow_path())
        for step in workflow.get("steps", []):
            if step.get("type") != "manual" or "login.gov.il" not in str(step.get("page_url") or ""):
                continue
            step["name"] = "אימות מאובטח והמשך אוטומטי למבא״ת"
            step["value"] = "השלם את האימות המאובטח בדפדפן; האוטומציה תמשיך לבד לאחר הצלחת הכניסה"
            step["auto_continue"] = True
            step["resume_when"] = {
                "url_not_contains": "login.gov.il",
                "url_contains_any": ["plan.mavat.moin.gov.il", "mavat.moin.gov.il"],
            }
        return workflow

    def write_workflow(self, workflow: dict[str, Any]) -> None:
        with self.lock:
            save_workflow(self.workflow_path(), workflow)
            self.workflow_revision += 1
            revision = self.workflow_revision
        self.publish_event("workflow-updated", revision=revision)

    def log(self, message: str) -> None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        path = self.log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] {message}\n")

    def publish_event(self, event_type: str, **payload: Any) -> None:
        event = {
            "type": event_type,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            **payload,
        }
        with self.lock:
            listeners = list(self.event_listeners)
        for listener in listeners:
            try:
                listener.put_nowait(event)
            except queue.Full:
                try:
                    listener.get_nowait()
                    listener.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass

    def follow_chrome_target(self, target_id: str, url: str = "", title: str = "") -> None:
        if not target_id:
            return
        changed = target_id != self.chrome_preview_target_id
        if changed:
            self.chrome_preview_target_id = target_id
            self.chrome_preview_frame = b""
            self.stop_chrome_preview_process()
        if url:
            self.chrome_preview_url = url
        if title:
            self.chrome_preview_title = title
        self.publish_event(
            "recording-target",
            target_id=target_id,
            url=url,
            title=title,
            changed=changed,
        )

    def recorded_step(self, step: dict[str, Any]) -> None:
        now = time.time()
        target_id = str(step.pop("_target_id", "") or "")
        if target_id:
            self.follow_chrome_target(target_id)
        step.setdefault("recorded_at", datetime.now().isoformat(timespec="seconds"))
        fingerprint = json.dumps(
            {
                "type": step.get("type"),
                "target": step.get("target"),
                "page_url": step.get("page_url"),
                "locator": step.get("locator"),
                "value": step.get("value") if step.get("type") != "fill_secret" else "",
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        with self.lock:
            if now < self.recorder_suppressed_until:
                self.log("הפעולה נקלטה במצב לימוד וממתינה לאישור לפני שמירה")
                return
            if (
                fingerprint == self.last_recorded_fingerprint
                and now - self.last_recorded_at < 3.0
            ):
                self.log(
                    f"התעלמות מקליטה כפולה: {step.get('name', step.get('type', ''))}"
                )
                return
            self.last_recorded_fingerprint = fingerprint
            self.last_recorded_at = now
            if step.get("type") != "fill_secret" and self.chrome_preview_frame:
                folder = self.store.base_dir / "screenshots" / "recording"
                folder.mkdir(parents=True, exist_ok=True)
                screenshot = folder / f"step_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.jpg"
                screenshot.write_bytes(self.chrome_preview_frame)
                step["screenshot"] = str(screenshot.resolve())
            workflow = self.read_workflow()
            workflow.setdefault("steps", []).append(step)
            self.write_workflow(workflow)
            self.log(f"נקלט שלב: {step.get('name', step.get('type', ''))}")
            self.publish_event(
                "step-recorded",
                name=str(step.get("name") or step.get("type") or ""),
                transport="raw-cdp-websocket",
            )
            if step.get("type") == "manual" and step.get("auto_continue"):
                self.log("זוהה אימות WebAuthn מאובטח: הבחירה מתבצעת ידנית והאוטומציה תמשיך אוטומטית לאחר הצלחה")
                self.publish_event(
                    "secure-auth-detected",
                    message="נדרש אישור בדיאלוג המאובטח של Chrome; לאחר הבחירה ההקלטה והאוטומציה ממשיכות לבד",
                )

    def recorded_secret(self, step: dict[str, Any], secret_value: str) -> None:
        if not secret_value:
            self.recorded_step(step)
            return
        workflow = self.read_workflow()
        profiles = self.store.profiles()
        linked_profile_id = next(
            (
                str(item.get("credential_profile_id") or "")
                for item in reversed(workflow.get("steps", []))
                if item.get("type") == "fill_secret"
                and item.get("credential_profile_id")
            ),
            "",
        )
        profile_id = linked_profile_id or (profiles[0].id if len(profiles) == 1 else "")
        if not profile_id:
            self.log(
                "נקלט שדה סיסמה, אך לא נמצא פרופיל כניסה יחיד; נוסף שלב מאובטח ללא שמירת הערך"
            )
            self.recorded_step(step)
            return
        try:
            self.store.set_password(profile_id, secret_value, persist_password=True)
            step["credential_profile_id"] = profile_id
            self.recorded_step(step)
            self.log(
                "הסיסמה שנקלטה נשמרה בכספת Windows Credential Manager וקושרה לשלב; הערך לא נכתב ל-workflow או ללוג"
            )
        except Exception as exc:
            self.log(f"שמירת הסיסמה בכספת נכשלה: {exc}")
            self.recorded_step(step)

    def start_recording(self) -> tuple[bool, str]:
        if self.recorder_thread and self.recorder_thread.is_alive():
            return True, "ההקלטה כבר פעילה"
        self.recording_state = "connecting"
        self.recording_message = "מתחבר לדפדפן האוטומציה..."
        selected, _ = self.browser_endpoint()
        has_relevant_page = any(
            any(fragment in str(page.get("url") or "").lower() for fragment in ("gov.il", "mavat", "iplan"))
            for page in (selected.pages or [])
        )
        if selected.provider == "browseros" and selected.connected and not has_relevant_page:
            open_browseros_page(selected, MAVAT_URL, background=True)
            time.sleep(0.35)
        port = selected.cdp_port

        def started(message: str) -> None:
            self.recording_state = "recording"
            self.recording_message = message
            self.log("הקלטת פעולות התחילה")
            self.publish_event("recording-status", state="recording", message=message)

        def finished(message: str) -> None:
            self.recording_state = "error" if message.startswith("ההקלטה נכשלה") else "idle"
            self.recording_message = message
            self.log(message)
            self.publish_event(
                "recording-status", state=self.recording_state, message=message
            )
            self.recorder = None

        self.recorder = BrowserRecorder(
            port,
            on_log=self.log,
            on_step=self.recorded_step,
            on_secret=self.recorded_secret,
            on_target=self.follow_chrome_target,
            on_started=started,
            on_finished=finished,
        )
        self.recorder_thread = threading.Thread(target=self.recorder.run, daemon=True)
        self.recorder_thread.start()
        return True, "מתחבר לדפדפן האוטומציה לצורך הקלטה"

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
            "current_step": self.current_step,
            "current_step_name": self.current_step_name,
            "current_step_action": self.current_step_action,
            "current_step_target": self.current_step_target,
            "started_at": self.run_started_at,
            "paused_from": self.run_paused_from,
            "last_error": self.last_error,
        }

    def start_run(self, profile_id: str, dry_run: bool, step_indices: list[int] | None = None) -> tuple[bool, str]:
        if self.runner_thread and self.runner_thread.is_alive():
            return False, "כבר מתבצעת הרצה"
        profiles = {profile.id: profile for profile in self.store.profiles()}
        profile = profiles.get(profile_id)
        if not profile:
            return False, "יש לבחור פרופיל כניסה"
        workflow = self.read_workflow()
        if step_indices is not None:
            valid_indices = sorted({index for index in step_indices if 0 <= index < len(workflow.get("steps", []))})
            if not valid_indices:
                return False, "לא נבחרו שלבים תקינים להרצה"
            selected_steps = []
            for index in valid_indices:
                step = json.loads(json.dumps(workflow["steps"][index], ensure_ascii=False))
                step["_original_step_number"] = index + 1
                selected_steps.append(step)
            workflow = {**workflow, "steps": selected_steps}
        data_file, _ = self.active_data_file()
        needs_records = any(step.get("scope", "per_record") == "per_record" for step in workflow.get("steps", []))
        if not data_file and needs_records:
            return False, "השלבים שנבחרו דורשים קובץ Excel, CSV או Word"
        if data_file:
            try:
                records = load_records(data_file)
            except Exception as exc:
                return False, f"טעינת הנתונים נכשלה: {exc}"
            if not records:
                return False, "קובץ הנתונים אינו מכיל רשומות"
        else:
            records = [{}]
        secrets = {item.id: self.store.get_password(item.id) for item in profiles.values()}
        self.run_state = "running"
        self.run_message = "בדיקת השלבים מתבצעת" if dry_run else "האוטומציה פועלת"
        self.run_current_row = 0
        self.run_total_rows = len(records)
        self.manual_message = ""
        self.current_step = 0
        self.current_step_name = ""
        self.current_step_action = ""
        self.current_step_target = ""
        self.run_started_at = datetime.now().isoformat(timespec="seconds")
        self.run_paused_from = ""
        self.last_error = {}

        def status(row: int, state: str, detail: str) -> None:
            self.run_current_row = row
            self.run_message = f"שורה {row}: {state}{' — ' + detail if detail else ''}"

        def manual(message: str) -> None:
            self.run_state = "manual"
            self.manual_message = message
            self.run_message = "ממתין לפעולה ידנית"
            self.log(f"נעצר ידנית: {message}")

        def step_status(row: int, step_number: int, name: str, state: str) -> None:
            self.run_current_row = row
            self.current_step = step_number
            self.current_step_name = name
            steps = self.read_workflow().get("steps", [])
            if 0 < step_number <= len(steps):
                active_step = steps[step_number - 1]
                self.current_step_action = str(active_step.get("type") or "")
                self.current_step_target = str(active_step.get("target") or "")
            if state == "running":
                self.run_message = f"מבצע שלב {step_number}: {name}"
            elif state == "success" and self.run_state == "manual":
                self.run_state = "running"
                self.manual_message = ""
                self.run_message = "האימות הושלם — האוטומציה ממשיכה"

        def run_error(details: dict[str, Any]) -> None:
            self.last_error = details
            self.run_state = "error"
            self.run_message = f"שלב {details.get('step')} נכשל: {details.get('step_name')}"

        def finished(message: str) -> None:
            self.run_state = "error" if "נכשלה" in message or "שגיאה" in message else "idle"
            self.run_message = message
            self.manual_message = ""
            self.log(message)

        selected_browser, _ = self.browser_endpoint()
        self.runner = WorkflowRunner(
            workflow=workflow, records=records,
            username=profile.username, password=secrets.get(profile.id, ""),
            default_profile_id=profile.id, secrets_by_profile=secrets,
            browser_profile_dir=str(self.store.data["browser_profile_dir"]),
            chrome_debug_port=selected_browser.cdp_port,
            callbacks=RunCallbacks(log=self.log, status=status, manual=manual, finished=finished, step=step_status, error=run_error),
            dry_run=dry_run,
            chrome_profile_directory=str(self.store.data.get("chrome_profile_directory") or "Default"),
            browser_provider=selected_browser.provider,
        )
        self.log(f"התחלת {'בדיקה' if dry_run else 'הרצה'} עבור {len(records)} רשומות")
        self.runner_thread = threading.Thread(target=self.runner.run, daemon=True)
        self.runner_thread.start()
        return True, self.run_message


runtime = Runtime()


def extension_origin() -> str:
    return str(request.headers.get("Origin") or "").rstrip("/")


def extension_request_id() -> str:
    origin_id = extension_id_from_origin(extension_origin())
    if origin_id:
        return origin_id
    claimed = str(
        request.headers.get("X-Mavat-Extension-Id")
        or request.args.get("extension_id")
        or ""
    ).strip().lower()
    return claimed if re.fullmatch(r"[a-p]{32}", claimed) else ""


def extension_identity_origin() -> str:
    extension_id = extension_request_id()
    return f"chrome-extension://{extension_id}" if extension_id else ""


def extension_bearer_token() -> str:
    header = str(request.headers.get("Authorization") or "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return str(request.args.get("token") or "").strip()


def extension_is_authenticated() -> bool:
    return runtime.extension_bridge.authenticate(extension_identity_origin(), extension_bearer_token())


def trusted_app_request() -> bool:
    origin = extension_origin()
    return not origin or origin in {
        f"http://127.0.0.1:{WEB_PORT}",
        "http://127.0.0.1:18474",
        "http://localhost:18474",
    }


def sanitized_extension_step(step: dict[str, Any], index: int) -> dict[str, Any]:
    secret = str(step.get("type") or "") == "fill_secret"
    return {
        "index": index,
        "name": str(step.get("name") or f"שלב {index + 1}"),
        "type": str(step.get("type") or "noop"),
        "target": str(step.get("target") or ""),
        "value": "" if secret else str(step.get("value") or ""),
        "page_url": str(step.get("page_url") or ""),
        "enabled": step.get("enabled", True) is not False,
        "confidence": int(step.get("confidence") or 0),
        "locator_strategy": str((step.get("locator") or {}).get("strategy") or "ידני"),
        "recorded_at": str(step.get("recorded_at") or ""),
        "has_screenshot": bool(step.get("screenshot")),
        "secret_status": str(step.get("_secret_status") or ("saved" if secret and step.get("credential_profile_id") else "")),
    }


def extension_state() -> dict[str, Any]:
    workflow = runtime.read_workflow()
    steps = workflow.get("steps") or []
    browser = runtime.chrome_cdp_status()
    return {
        "ok": True,
        "revision": runtime.workflow_revision,
        "automation": {
            "id": runtime.active_automation_id(),
            "name": str(runtime.active_automation().get("name") or workflow.get("name") or "אוטומציית מבא״ת"),
        },
        "recording": {
            "state": runtime.recording_state,
            "message": runtime.recording_message,
        },
        "browser": {
            "connected": bool(browser.get("connected")),
            "display_name": str(browser.get("display_name") or "BrowserOS"),
            "target_title": runtime.chrome_preview_title,
            "target_url": runtime.chrome_preview_url,
        },
        "steps": [sanitized_extension_step(dict(step), index) for index, step in enumerate(steps)],
    }


@app.after_request
def extension_cors(response: Response) -> Response:
    origin = extension_origin()
    if request.path.startswith("/api/extension/") and extension_id_from_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Mavat-Extension-Id"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Max-Age"] = "600"
        response.headers.add("Vary", "Origin")
    return response


@app.get("/api/extension/ping")
def api_extension_ping() -> Response:
    if not extension_request_id():
        return jsonify({"ok": False, "error": "מקור תוסף חסר"}), 403
    return jsonify({
        "ok": True,
        "service": "mavat-automation",
        "version": 1,
        "paired": extension_is_authenticated(),
        "requires_pairing": not extension_is_authenticated(),
    })


@app.post("/api/extension/pair")
def api_extension_pair() -> Response:
    origin = extension_identity_origin()
    try:
        token = runtime.extension_bridge.pair(
            origin,
            str((request.get_json(force=True) or {}).get("code") or ""),
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    runtime.log(f"תוסף ההקלטה חובר: {extension_request_id()[:8]}…")
    return jsonify({"ok": True, "token": token, "state": extension_state()})


@app.get("/api/extension/state")
def api_extension_state() -> Response:
    if not extension_is_authenticated():
        return jsonify({"ok": False, "error": "נדרש חיבור מחדש לתוכנה"}), 401
    return jsonify(extension_state())


@app.post("/api/extension/recording/<action>")
def api_extension_recording(action: str) -> Response:
    if not extension_is_authenticated():
        return jsonify({"ok": False, "error": "נדרש חיבור מחדש לתוכנה"}), 401
    if action == "start":
        ok, message = runtime.start_recording()
        return jsonify({"ok": ok, "message": message, "state": extension_state()})
    if action == "stop":
        return jsonify({"ok": True, "message": runtime.stop_recording(), "state": extension_state()})
    return jsonify({"ok": False, "error": "פעולת הקלטה לא מוכרת"}), 400


@app.post("/api/extension/steps/undo")
def api_extension_undo_step() -> Response:
    if not extension_is_authenticated():
        return jsonify({"ok": False, "error": "נדרש חיבור מחדש לתוכנה"}), 401
    with runtime.lock:
        workflow = runtime.read_workflow()
        steps = workflow.get("steps") or []
        if not steps:
            return jsonify({"ok": False, "error": "אין פעולה אחרונה לביטול"}), 400
        removed = steps.pop()
        runtime.write_workflow(workflow)
    runtime.log(f"בוטל השלב האחרון מהסיידבר: {removed.get('name', '')}")
    return jsonify({"ok": True, "state": extension_state()})


@app.post("/api/extension/steps/<int:index>/<action>")
def api_extension_step_action(index: int, action: str) -> Response:
    if not extension_is_authenticated():
        return jsonify({"ok": False, "error": "נדרש חיבור מחדש לתוכנה"}), 401
    payload = request.get_json(silent=True) or {}
    with runtime.lock:
        workflow = runtime.read_workflow()
        steps = workflow.get("steps") or []
        if index < 0 or index >= len(steps):
            return jsonify({"ok": False, "error": "השלב לא נמצא"}), 404
        if action == "delete":
            del steps[index]
        elif action == "duplicate":
            duplicate = json.loads(json.dumps(steps[index], ensure_ascii=False))
            duplicate["name"] = f"{duplicate.get('name', 'שלב')} (עותק)"
            duplicate["recorded_at"] = datetime.now().isoformat(timespec="seconds")
            steps.insert(index + 1, duplicate)
        elif action in {"pause", "resume"}:
            steps[index]["enabled"] = action == "resume"
        elif action == "rename":
            name = str(payload.get("name") or "").strip()[:180]
            if not name:
                return jsonify({"ok": False, "error": "יש להזין שם לשלב"}), 400
            steps[index]["name"] = name
        else:
            return jsonify({"ok": False, "error": "פעולת שלב לא מוכרת"}), 400
        runtime.write_workflow(workflow)
    return jsonify({"ok": True, "state": extension_state()})


@app.get("/api/extension/steps/<int:index>/thumbnail")
def api_extension_step_thumbnail(index: int) -> Response:
    if not extension_is_authenticated():
        return jsonify({"ok": False, "error": "נדרש חיבור מחדש לתוכנה"}), 401
    steps = runtime.read_workflow().get("steps") or []
    if index < 0 or index >= len(steps):
        return jsonify({"ok": False, "error": "השלב לא נמצא"}), 404
    path = Path(str(steps[index].get("screenshot") or ""))
    try:
        resolved_path = path.resolve(strict=True)
        screenshot_root = (runtime.store.base_dir / "screenshots").resolve(strict=True)
    except OSError:
        return jsonify({"ok": False, "error": "אין צילום לשלב זה"}), 404
    if screenshot_root not in resolved_path.parents or not resolved_path.is_file():
        return jsonify({"ok": False, "error": "נתיב הצילום אינו מורשה"}), 403
    return send_file(resolved_path, mimetype="image/jpeg", max_age=0)


@app.post("/api/extension/open-editor")
def api_extension_open_editor() -> Response:
    if not extension_is_authenticated():
        return jsonify({"ok": False, "error": "נדרש חיבור מחדש לתוכנה"}), 401
    runtime.publish_event("extension-open-editor", route="/recorder")
    return jsonify({"ok": True})


@app.get("/api/extension/admin/status")
def api_extension_admin_status() -> Response:
    if not trusted_app_request():
        return jsonify({"ok": False, "error": "גישה נדחתה"}), 403
    return jsonify({"ok": True, **runtime.extension_status(include_code=True)})


@app.post("/api/extension/admin/pairing-code")
def api_extension_admin_pairing_code() -> Response:
    if not trusted_app_request():
        return jsonify({"ok": False, "error": "גישה נדחתה"}), 403
    runtime.extension_bridge.create_pairing_code()
    return jsonify({"ok": True, **runtime.extension_status(include_code=True)})


@app.post("/api/extension/admin/revoke")
def api_extension_admin_revoke() -> Response:
    if not trusted_app_request():
        return jsonify({"ok": False, "error": "גישה נדחתה"}), 403
    runtime.extension_bridge.revoke_all()
    runtime.log("כל חיבורי תוסף ההקלטה בוטלו")
    return jsonify({"ok": True, **runtime.extension_status(include_code=True)})


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


def browseros_executable() -> str:
    candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "BrowserOS/Application/chrome.exe"
    if candidate.is_file():
        return str(candidate)
    raise FileNotFoundError("BrowserOS אינו מותקן במחשב")


def chrome_user_data_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"


def chrome_profile_catalog(root: Path) -> list[dict[str, Any]]:
    metadata: dict[str, Any] = {}
    local_state = root / "Local State"
    if local_state.is_file():
        try:
            state = json.loads(local_state.read_text(encoding="utf-8"))
            metadata = state.get("profile", {}).get("info_cache", {})
        except (OSError, json.JSONDecodeError, AttributeError):
            metadata = {}
    directories = [
        item for item in root.iterdir()
        if item.is_dir() and (item.name == "Default" or re.fullmatch(r"Profile \d+", item.name))
    ] if root.is_dir() else []
    result: list[dict[str, Any]] = []
    for directory in sorted(directories, key=lambda item: (item.name != "Default", item.name)):
        details = metadata.get(directory.name, {}) if isinstance(metadata, dict) else {}
        result.append({
            "directory": directory.name,
            "name": str(details.get("name") or directory.name),
            "account": str(details.get("user_name") or ""),
            "avatar": str(details.get("avatar_icon") or ""),
        })
    return result


def chrome_import_size(root: Path, profile_names: set[str]) -> int:
    ignored = {"Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "Media Cache"}
    total = 0
    for profile_name in profile_names:
        profile_path = root / profile_name
        for current, directories, files in os.walk(profile_path):
            directories[:] = [name for name in directories if name not in ignored]
            for filename in files:
                try:
                    total += (Path(current) / filename).stat().st_size
                except OSError:
                    continue
    return total


def copy_sqlite_snapshot(source: Path, destination: Path) -> None:
    """Copy a live Chrome SQLite database without reading or exposing its records."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.importing")
    temporary.unlink(missing_ok=True)
    source_db = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True, timeout=15)
    target_db = sqlite3.connect(temporary, timeout=15)
    try:
        source_db.backup(target_db)
    finally:
        target_db.close()
        source_db.close()
    temporary.replace(destination)


def repair_locked_chrome_databases() -> list[str]:
    source_root = chrome_user_data_dir()
    target_root = Path(str(runtime.store.data["browser_profile_dir"]))
    imported = {item["directory"] for item in chrome_profile_catalog(target_root)}
    failures: list[str] = []
    database_paths = ("Network/Cookies", "History", "Login Data", "Web Data", "Favicons", "Top Sites")
    for profile in chrome_profile_catalog(source_root):
        directory = str(profile["directory"])
        if directory not in imported:
            continue
        for relative in database_paths:
            source = source_root / directory / Path(relative)
            destination = target_root / directory / Path(relative)
            if not source.is_file() or destination.is_file():
                continue
            try:
                copy_sqlite_snapshot(source, destination)
            except (OSError, sqlite3.Error) as exc:
                failures.append(f"{profile['name']} — {relative}: {exc}")
    return failures


def keep_only_chrome_profile(directory: str) -> int:
    target_root = Path(str(runtime.store.data["browser_profile_dir"])).resolve()
    available = {item["directory"] for item in chrome_profile_catalog(target_root)}
    if directory not in available:
        raise ValueError("פרופיל Chrome שנבחר לא נמצא בעותק המקומי")
    removed = 0
    for profile_directory in sorted(available - {directory}):
        candidate = (target_root / profile_directory).resolve()
        if candidate.parent != target_root or not (profile_directory == "Default" or re.fullmatch(r"Profile \d+", profile_directory)):
            raise ValueError("נתיב פרופיל Chrome אינו בטוח למחיקה")
        shutil.rmtree(candidate)
        removed += 1
    local_state = target_root / "Local State"
    if local_state.is_file():
        try:
            state = json.loads(local_state.read_text(encoding="utf-8"))
            profile_state = state.setdefault("profile", {})
            info_cache = profile_state.get("info_cache", {})
            profile_state["info_cache"] = {directory: info_cache[directory]} if directory in info_cache else {}
            profile_state["last_used"] = directory
            profile_state["last_active_profiles"] = [directory]
            profile_state["profiles_order"] = [directory]
            local_state.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        except (OSError, json.JSONDecodeError, TypeError, KeyError):
            pass
    runtime.store.data["chrome_profile_directory"] = directory
    runtime.store.save()
    runtime.chrome_import_warnings = []
    runtime.chrome_import_state = "completed"
    runtime.chrome_import_message = "פרופיל Chrome יחיד מוכן לאוטומציה"
    return removed


def start_chrome_import(profile_names: list[str]) -> tuple[bool, str]:
    if runtime.chrome_import_thread and runtime.chrome_import_thread.is_alive():
        return False, "ייבוא Chrome כבר מתבצע"
    source = chrome_user_data_dir()
    target = Path(str(runtime.store.data["browser_profile_dir"]))
    catalog = chrome_profile_catalog(source)
    available = {item["directory"] for item in catalog}
    selected = available if not profile_names or "all" in profile_names else available.intersection(profile_names)
    if not selected:
        return False, "לא נמצאו פרופילי Chrome לייבוא"
    required = chrome_import_size(source, selected)
    free = shutil.disk_usage(target.parent).free
    if required + 2_000_000_000 > free:
        return False, f"אין מספיק מקום פנוי. נדרשים כ-{required / 1_000_000_000:.1f} GB"

    runtime.chrome_import_state = "preparing"
    runtime.chrome_import_message = "מכין עותק מקומי של פרופילי Chrome"
    runtime.chrome_import_current = 0
    runtime.chrome_import_total = len(selected)
    runtime.chrome_import_warnings = []

    def worker() -> None:
        backup: Path | None = None
        try:
            if target.exists() and any(target.iterdir()):
                stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup = target.with_name(f"{target.name}_backup_{stamp}")
                target.replace(backup)
            target.mkdir(parents=True, exist_ok=True)
            for filename in ("Local State", "First Run"):
                source_file = source / filename
                if source_file.is_file():
                    try:
                        shutil.copy2(source_file, target / filename)
                    except OSError as exc:
                        runtime.chrome_import_warnings.append(f"{filename}: {exc}")
            ordered = [item for item in catalog if item["directory"] in selected]
            for index, profile in enumerate(ordered, start=1):
                name = str(profile["directory"])
                runtime.chrome_import_state = "copying"
                runtime.chrome_import_current = index
                runtime.chrome_import_message = f"מייבא {profile['name']} ({index} מתוך {len(ordered)})"
                destination = target / name
                command = [
                    "robocopy", str(source / name), str(destination), "/E", "/COPY:DAT", "/DCOPY:DAT",
                    "/R:1", "/W:1", "/XJ", "/NFL", "/NDL", "/NP",
                    "/XD", "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "Media Cache",
                ]
                result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
                if result.returncode >= 8:
                    runtime.chrome_import_warnings.append(f"{profile['name']}: Chrome החזיק מספר קבצים פתוחים; מתבצעת השלמה בטוחה")
            database_failures = repair_locked_chrome_databases()
            runtime.chrome_import_warnings = database_failures
            expected = str(runtime.store.data.get("chrome_account_email") or "").casefold()
            preferred = next((item["directory"] for item in ordered if str(item.get("account") or "").casefold() == expected), None)
            runtime.store.data["chrome_profile_directory"] = preferred or ("Default" if "Default" in selected else ordered[0]["directory"])
            runtime.store.data["chrome_import_backup"] = str(backup or "")
            runtime.store.data["chrome_imported_at"] = datetime.now().isoformat(timespec="seconds")
            runtime.store.save()
            runtime.chrome_import_state = "completed"
            runtime.chrome_import_message = f"הייבוא הושלם: {len(ordered)} פרופילים זמינים לאוטומציה"
            runtime.log(runtime.chrome_import_message)
        except Exception as exc:
            runtime.chrome_import_state = "error"
            runtime.chrome_import_message = f"ייבוא Chrome נכשל: {exc}"
            runtime.chrome_import_warnings.append(str(exc))
            runtime.log(runtime.chrome_import_message)

    runtime.chrome_import_thread = threading.Thread(target=worker, daemon=True)
    runtime.chrome_import_thread.start()
    return True, f"התחיל ייבוא של {len(selected)} פרופילי Chrome"


def parse_logs() -> list[dict[str, Any]]:
    log_path = runtime.log_path()
    if not log_path.exists():
        return []
    events: list[dict[str, Any]] = []
    pattern = re.compile(r"^\[(?P<timestamp>[^]]+)]\s*(?P<message>.*)$")
    for line_number, raw in enumerate(log_path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        match = pattern.match(raw)
        timestamp = match.group("timestamp") if match else ""
        message = match.group("message") if match else raw
        lower = message.lower()
        if any(word in message for word in ("שגיאה", "נכשלה", "חריגה", "כשל")) or "error" in lower:
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
    if FRONTEND_DIR.exists():
        return redirect("/app/")
    return redirect("http://127.0.0.1:18474/")


@app.get("/app/")
@app.get("/app/<path:asset_path>")
def packaged_frontend(asset_path: str = "") -> Response:
    """Serve the packaged React SPA while keeping API and WebSocket same-origin."""
    candidate = FRONTEND_DIR / asset_path
    if asset_path and candidate.is_file():
        return send_from_directory(FRONTEND_DIR, asset_path)
    return send_from_directory(FRONTEND_DIR, "electron.index.html")


@app.get("/favicon.ico")
def packaged_favicon() -> Response:
    return send_from_directory(FRONTEND_DIR, "favicon.ico")


@app.get("/workflow")
def workflow_page() -> Response:
    return redirect("http://127.0.0.1:18474/workflow")


@app.get("/runs")
def runs_page() -> Response:
    return redirect("http://127.0.0.1:18474/logs")


@app.get("/api/automations")
def api_automations() -> Response:
    items: list[dict[str, Any]] = []
    for automation in runtime.automations():
        item = dict(automation)
        workflow = load_workflow(runtime.workflow_path(str(item.get("id"))))
        item["steps_count"] = len(workflow.get("steps", []))
        item["active"] = str(item.get("id")) == runtime.active_automation_id()
        items.append(item)
    return jsonify({"automations": items, "active_id": runtime.active_automation_id()})


DEFAULT_AUTOMATION_INPUTS = [
    {"key": "client_name", "label": "שם לקוח", "type": "text", "required": False},
    {"key": "plan_name", "label": "שם התוכנית", "type": "text", "required": True},
    {"key": "committee", "label": "ועדה", "type": "autocomplete", "required": True, "options": ["שדות דן"]},
    {"key": "plan_type", "label": "סוג תוכנית", "type": "autocomplete", "required": True, "options": ["תוכנית מתאר מקומית"]},
    {"key": "planning_area", "label": "מרחב תכנון", "type": "autocomplete", "required": False},
    {"key": "locality", "label": "יישוב", "type": "autocomplete", "required": False},
    {"key": "block", "label": "גוש", "type": "number", "required": True},
    {"key": "parcel", "label": "חלקה", "type": "number", "required": True},
    {"key": "lot", "label": "מגרש", "type": "text", "required": False},
    {"key": "area", "label": "שטח בדונם", "type": "decimal", "required": True},
]


@app.get("/api/automations/<automation_id>")
def api_automation_detail(automation_id: str) -> Response:
    automation = next((item for item in runtime.automations() if str(item.get("id")) == automation_id), None)
    if not automation:
        return jsonify({"ok": False, "error": "האוטומציה לא נמצאה"}), 404
    workflow = load_workflow(runtime.workflow_path(automation_id))
    return jsonify({
        "automation": automation,
        "workflow": workflow,
        "input_schema": automation.get("input_schema") or DEFAULT_AUTOMATION_INPUTS,
    })


@app.put("/api/automations/<automation_id>/input-schema")
def api_update_automation_input_schema(automation_id: str) -> Response:
    payload = request.get_json(force=True) or {}
    fields = payload.get("fields") or []
    if not isinstance(fields, list) or not fields:
        return jsonify({"ok": False, "error": "יש להגדיר לפחות שדה קלט אחד"}), 400
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in fields:
        key = re.sub(r"[^a-zA-Z0-9_]", "", str(raw.get("key") or "").strip())
        label = str(raw.get("label") or "").strip()
        field_type = str(raw.get("type") or "text")
        if not key or not label or key in seen:
            return jsonify({"ok": False, "error": "מפתח ושם שדה חייבים להיות ייחודיים ותקינים"}), 400
        if field_type not in {"text", "number", "decimal", "select", "autocomplete", "date"}:
            return jsonify({"ok": False, "error": f"סוג שדה לא נתמך: {field_type}"}), 400
        seen.add(key)
        normalized.append({
            "key": key, "label": label, "type": field_type,
            "required": bool(raw.get("required", False)),
            "options": [str(value) for value in (raw.get("options") or [])],
        })
    automation = next((item for item in runtime.automations() if str(item.get("id")) == automation_id), None)
    if not automation:
        return jsonify({"ok": False, "error": "האוטומציה לא נמצאה"}), 404
    automation["input_schema"] = normalized
    runtime.store.save()
    return jsonify({"ok": True, "input_schema": normalized})


@app.post("/api/automations")
def api_create_automation() -> Response:
    payload = request.get_json(force=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "יש להזין שם לאוטומציה"}), 400
    automation_id = uuid.uuid4().hex
    source_id = str(payload.get("source_id") or "").strip()
    description = str(payload.get("description") or "").strip() or "תהליך אוטומציה חדש"
    source = next((item for item in runtime.automations() if str(item.get("id")) == source_id), None)
    automation = {
        "id": automation_id,
        "name": name,
        "description": description,
        "status": "draft",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "input_schema": json.loads(json.dumps(
            source.get("input_schema") if source and source.get("input_schema") else DEFAULT_AUTOMATION_INPUTS,
            ensure_ascii=False,
        )),
    }
    if source:
        automation["data_file"] = str(source.get("data_file") or "")
        automation["data_file_name"] = str(source.get("data_file_name") or "")
        source_workflow = load_workflow(runtime.workflow_path(source_id))
        source_workflow["name"] = name
        save_workflow(runtime.workflow_path(automation_id), source_workflow)
    else:
        save_workflow(runtime.workflow_path(automation_id), {"name": name, "steps": []})
    runtime.store.data.setdefault("automations", []).append(automation)
    runtime.store.save()
    runtime.log(f"נוצרה אוטומציה חדשה: {name}")
    return jsonify({"ok": True, "automation": automation})


@app.get("/api/automations/library")
def api_automation_library() -> Response:
    items = []
    for automation in runtime.automations():
        automation_id = str(automation.get("id") or "")
        workflow = load_workflow(runtime.workflow_path(automation_id))
        items.append({
            "id": automation_id,
            "name": str(automation.get("name") or automation_id),
            "description": str(automation.get("description") or ""),
            "steps": workflow.get("steps", []),
        })
    return jsonify({"automations": items, "active_id": runtime.active_automation_id()})


@app.post("/api/automations/from-steps")
def api_create_automation_from_steps() -> Response:
    payload = request.get_json(force=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "יש להזין שם לאוטומציה החדשה"}), 400
    selections = payload.get("selections") or []
    combined_steps: list[dict[str, Any]] = []
    for selection in selections:
        source_id = str(selection.get("automation_id") or "")
        source_path = runtime.workflow_path(source_id)
        if not source_path.is_file():
            continue
        source_steps = load_workflow(source_path).get("steps", [])
        for index in sorted({int(value) for value in selection.get("indices") or []}):
            if 0 <= index < len(source_steps):
                combined_steps.append(json.loads(json.dumps(source_steps[index], ensure_ascii=False)))
    if not combined_steps:
        return jsonify({"ok": False, "error": "לא נבחרו שלבים לבניית האוטומציה"}), 400
    automation_id = uuid.uuid4().hex
    automation = {
        "id": automation_id, "name": name,
        "description": str(payload.get("description") or "אוטומציה שהורכבה משלבים קיימים"),
        "status": "draft", "created_at": datetime.now().isoformat(timespec="seconds"),
        "input_schema": json.loads(json.dumps(DEFAULT_AUTOMATION_INPUTS, ensure_ascii=False)),
    }
    save_workflow(runtime.workflow_path(automation_id), {"name": name, "steps": combined_steps})
    runtime.store.data.setdefault("automations", []).append(automation)
    runtime.store.save()
    runtime.log(f"נוצרה אוטומציה '{name}' מתוך {len(combined_steps)} שלבים קיימים")
    return jsonify({"ok": True, "automation": automation, "steps_count": len(combined_steps)})


@app.post("/api/automations/<automation_id>/activate")
def api_activate_automation(automation_id: str) -> Response:
    try:
        automation = runtime.activate_automation(automation_id)
    except (ValueError, RuntimeError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "automation": automation})


@app.delete("/api/automations/<automation_id>")
def api_delete_automation(automation_id: str) -> Response:
    automations = runtime.automations()
    if len(automations) <= 1:
        return jsonify({"ok": False, "error": "חייבת להישאר לפחות אוטומציה אחת"}), 400
    if automation_id == runtime.active_automation_id():
        return jsonify({"ok": False, "error": "בחר אוטומציה אחרת לפני המחיקה"}), 400
    remaining = [item for item in automations if str(item.get("id")) != automation_id]
    if len(remaining) == len(automations):
        return jsonify({"ok": False, "error": "האוטומציה לא נמצאה"}), 404
    runtime.store.data["automations"] = remaining
    runtime.store.save()
    runtime.workflow_path(automation_id).unlink(missing_ok=True)
    return jsonify({"ok": True})


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
    return jsonify({
        "workflow": workflow,
        "profiles": profile_status,
        "automation": runtime.active_automation(),
    })


@app.get("/api/settings")
def api_settings() -> Response:
    data_path, data_name = runtime.active_data_file()
    preview: list[dict[str, Any]] = []
    error = ""
    if data_path:
        try:
            preview = load_records(data_path)[:5]
        except Exception as exc:
            error = str(exc)
    browser_status = runtime.chrome_cdp_status()
    return jsonify({
        "data_file": data_path,
        "data_file_name": data_name or (Path(data_path).name if data_path else ""),
        "preview": preview,
        "preview_count": len(preview),
        "error": error,
        "run": runtime.run_status(),
        "browser_provider": str(runtime.store.data.get("browser_provider") or "auto"),
        "browser": browser_status,
        "extension_bridge": runtime.extension_status(include_code=True),
    })


@app.post("/api/settings/browser-provider")
def api_set_browser_provider() -> Response:
    provider = str((request.get_json(force=True) or {}).get("provider") or "auto").lower()
    if provider not in {"auto", "browseros", "chrome"}:
        return jsonify({"ok": False, "error": "ספק הדפדפן אינו תקין"}), 400
    runtime.store.data["browser_provider"] = provider
    runtime.store.save()
    runtime.chrome_preview_target_id = ""
    runtime.chrome_preview_frame = b""
    runtime.stop_chrome_preview_process()
    status = runtime.chrome_cdp_status()
    runtime.log(
        f"ספק הדפדפן עודכן ל-{provider}; נבחר כעת {status.get('display_name')} בפורט {status.get('port')}"
    )
    return jsonify({"ok": True, "browser_provider": provider, "browser": status})


@app.post("/api/settings/data-file")
def api_set_data_file() -> Response:
    path = Path(str((request.get_json(force=True) or {}).get("path") or ""))
    try:
        records = load_records(path)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"לא ניתן לקרוא את הקובץ: {exc}"}), 400
    runtime.set_active_data_file(str(path.resolve()), path.name)
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
    runtime.set_active_data_file(str(target), uploaded.filename)
    return jsonify({"ok": True, "name": uploaded.filename, "count": len(records), "preview": records[:5]})


@app.post("/api/run/start")
def api_run_start() -> Response:
    payload = request.get_json(force=True) or {}
    indices_payload = payload.get("step_indices")
    step_indices = [int(value) for value in indices_payload] if isinstance(indices_payload, list) else None
    ok, message = runtime.start_run(
        str(payload.get("profile_id") or ""), bool(payload.get("dry_run", True)), step_indices
    )
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@app.post("/api/run/stop")
def api_run_stop() -> Response:
    if runtime.runner:
        runtime.runner.stop()
        runtime.run_state = "stopping"
        runtime.run_message = "עוצר את ההרצה..."
    return jsonify({"ok": True, **runtime.run_status()})


@app.post("/api/run/pause")
def api_run_pause() -> Response:
    if not runtime.runner or runtime.run_state != "running":
        return jsonify({"ok": False, "error": "אין כרגע הרצה פעילה שניתן להשהות"}), 400
    runtime.runner.pause()
    runtime.run_paused_from = runtime.run_message
    runtime.run_state = "paused"
    runtime.run_message = "ההרצה מושהית על ידי המשתמש"
    runtime.log(f"ההרצה הושהתה בשלב {runtime.current_step}: {runtime.current_step_name}")
    return jsonify({"ok": True, **runtime.run_status()})


@app.post("/api/run/resume")
def api_run_resume() -> Response:
    if not runtime.runner or runtime.run_state != "paused":
        return jsonify({"ok": False, "error": "אין כרגע הרצה מושהית"}), 400
    runtime.runner.resume()
    runtime.run_state = "running"
    runtime.run_message = runtime.run_paused_from or "ממשיך בהרצה"
    runtime.run_paused_from = ""
    runtime.log("ההרצה חודשה")
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


@app.get("/api/run/error-screenshot")
def api_run_error_screenshot() -> Response:
    path = Path(str(runtime.last_error.get("screenshot") or ""))
    if not path.is_file():
        return jsonify({"ok": False, "error": "לא נמצא צילום כשל"}), 404
    return send_file(path, mimetype="image/png")


@app.get("/api/steps/<int:index>/screenshot")
def api_step_screenshot(index: int) -> Response:
    steps = runtime.read_workflow().get("steps", [])
    if index < 0 or index >= len(steps):
        return jsonify({"ok": False, "error": "השלב לא נמצא"}), 404
    path = Path(str(steps[index].get("screenshot") or ""))
    if not path.is_file():
        return jsonify({"ok": False, "error": "לא נשמר צילום לשלב זה"}), 404
    return send_file(path, mimetype="image/jpeg", max_age=0)


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


@app.post("/api/steps/import")
def api_import_steps() -> Response:
    payload = request.get_json(force=True) or {}
    source_id = str(payload.get("source_id") or "")
    source_path = runtime.workflow_path(source_id)
    if not source_path.is_file():
        return jsonify({"ok": False, "error": "אוטומציית המקור לא נמצאה"}), 404
    source_steps = load_workflow(source_path).get("steps", [])
    indices = sorted({int(value) for value in payload.get("indices") or []})
    selected_steps = [
        json.loads(json.dumps(source_steps[index], ensure_ascii=False))
        for index in indices if 0 <= index < len(source_steps)
    ]
    if not selected_steps:
        return jsonify({"ok": False, "error": "לא נבחרו שלבים לייבוא"}), 400
    workflow = runtime.read_workflow()
    steps = workflow.setdefault("steps", [])
    position = max(0, min(int(payload.get("position", len(steps))), len(steps)))
    steps[position:position] = selected_steps
    runtime.write_workflow(workflow)
    runtime.log(f"יובאו {len(selected_steps)} שלבים מאוטומציה אחרת")
    return jsonify({"ok": True, "imported": len(selected_steps), "position": position})


@app.put("/api/steps/<int:index>")
def api_update_step(index: int) -> Response:
    workflow = runtime.read_workflow()
    steps = workflow.get("steps", [])
    if index < 0 or index >= len(steps):
        return jsonify({"ok": False, "error": "השלב לא נמצא"}), 404
    updates = request.get_json(force=True) or {}
    allowed = {"name", "type", "scope", "target", "value", "timeout_seconds", "enabled", "credential_profile_id", "locator", "fallbacks", "page_url", "position", "confidence", "recorded_at", "screenshot", "auto_continue", "resume_when"}
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
    elif action == "duplicate":
        for index in reversed(valid):
            duplicate = json.loads(json.dumps(steps[index], ensure_ascii=False))
            duplicate["name"] = f"{duplicate.get('name', 'שלב')} (עותק)"
            duplicate["recorded_at"] = datetime.now().isoformat(timespec="seconds")
            steps.insert(index + 1, duplicate)
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
    return jsonify({
        "state": runtime.recording_state,
        "message": runtime.recording_message,
        "transport": "raw-cdp-websocket",
        "background": True,
    })


@sock.route("/ws/events")
def websocket_events(ws: Any) -> None:
    listener: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=200)
    with runtime.lock:
        runtime.event_listeners.append(listener)
    try:
        ws.send(json.dumps({
            "type": "connected",
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "transport": "raw-cdp-websocket",
            "background": True,
            "recording_state": runtime.recording_state,
        }, ensure_ascii=False))
        while True:
            try:
                event = listener.get(timeout=15)
            except queue.Empty:
                event = {
                    "type": "heartbeat",
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                    "transport": "raw-cdp-websocket",
                }
            ws.send(json.dumps(event, ensure_ascii=False))
    except Exception:
        pass
    finally:
        with runtime.lock:
            if listener in runtime.event_listeners:
                runtime.event_listeners.remove(listener)


@sock.route("/ws/extension")
def websocket_extension(ws: Any) -> None:
    """Authenticated, event-only channel for the BrowserOS side panel."""
    if not extension_is_authenticated():
        try:
            ws.send(json.dumps({"type": "authentication-required"}, ensure_ascii=False))
            ws.close()
        except Exception:
            pass
        return
    extension_id = extension_request_id()
    listener: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=200)
    with runtime.lock:
        runtime.event_listeners.append(listener)
        runtime.extension_live_connections[extension_id] = (
            runtime.extension_live_connections.get(extension_id, 0) + 1
        )
    try:
        ws.send(json.dumps({
            "type": "connected",
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "revision": runtime.workflow_revision,
            "recording_state": runtime.recording_state,
            "transport": "raw-cdp-websocket",
        }, ensure_ascii=False))
        while True:
            try:
                event = listener.get(timeout=15)
            except queue.Empty:
                event = {
                    "type": "heartbeat",
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                    "revision": runtime.workflow_revision,
                }
            ws.send(json.dumps(event, ensure_ascii=False))
    except Exception:
        pass
    finally:
        with runtime.lock:
            if listener in runtime.event_listeners:
                runtime.event_listeners.remove(listener)
            remaining = runtime.extension_live_connections.get(extension_id, 1) - 1
            if remaining > 0:
                runtime.extension_live_connections[extension_id] = remaining
            else:
                runtime.extension_live_connections.pop(extension_id, None)


@app.get("/api/chrome/profiles")
def api_chrome_profiles() -> Response:
    source = chrome_profile_catalog(chrome_user_data_dir())
    target_root = Path(str(runtime.store.data["browser_profile_dir"]))
    imported = {item["directory"] for item in chrome_profile_catalog(target_root)}
    profiles = [{**item, "imported": item["directory"] in imported} for item in source]
    return jsonify({
        "profiles": profiles,
        "selected_directory": str(runtime.store.data.get("chrome_profile_directory") or "Default"),
        "source_count": len(source),
        "imported_count": len(imported.intersection({item["directory"] for item in source})),
        "import": runtime.chrome_import_status(),
    })


@app.post("/api/chrome/import")
def api_chrome_import() -> Response:
    payload = request.get_json(force=True) or {}
    names = [str(value) for value in payload.get("profiles", ["all"])]
    ok, message = start_chrome_import(names)
    return jsonify({"ok": ok, "message": message}), (200 if ok else 400)


@app.post("/api/chrome/select")
def api_chrome_select() -> Response:
    directory = str((request.get_json(force=True) or {}).get("directory") or "")
    target_root = Path(str(runtime.store.data["browser_profile_dir"]))
    available = {item["directory"] for item in chrome_profile_catalog(target_root)}
    if directory not in available:
        return jsonify({"ok": False, "error": "פרופיל Chrome עדיין לא יובא"}), 400
    runtime.store.data["chrome_profile_directory"] = directory
    runtime.store.save()
    return jsonify({"ok": True, "directory": directory})


@app.post("/api/chrome/keep-only")
def api_chrome_keep_only() -> Response:
    directory = str((request.get_json(force=True) or {}).get("directory") or "")
    try:
        removed = keep_only_chrome_profile(directory)
    except (OSError, ValueError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    runtime.log(f"נשמר רק פרופיל Chrome {directory}; הוסרו {removed} עותקי פרופילים אחרים")
    return jsonify({"ok": True, "removed": removed})


@app.post("/api/chrome/repair")
def api_chrome_repair() -> Response:
    failures = repair_locked_chrome_databases()
    runtime.chrome_import_warnings = failures
    if failures:
        return jsonify({"ok": False, "error": "חלק מקבצי Chrome עדיין נעולים", "warnings": failures}), 400
    runtime.chrome_import_state = "completed"
    runtime.chrome_import_message = "כל קובצי הליבה של פרופיל Chrome הושלמו"
    return jsonify({"ok": True, "message": runtime.chrome_import_message})


@app.post("/api/chrome/open")
def api_open_chrome() -> Response:
    try:
        selected, _ = runtime.browser_endpoint()
        if selected.provider == "browseros":
            if not selected.connected:
                subprocess.Popen([browseros_executable()], cwd=str(ROOT_DIR))
                deadline = time.time() + 12
                while time.time() < deadline:
                    time.sleep(0.25)
                    selected, _ = runtime.browser_endpoint()
                    if selected.provider == "browseros" and selected.connected:
                        break
            if selected.connected:
                open_browseros_page(selected, MAVAT_URL, background=True)
                threading.Timer(0.5, runtime.ensure_chrome_preview).start()
                runtime.log(
                    f"BrowserOS חובר דרך MCP מקומי ו-CDP {selected.cdp_port}; דף מבא״ת נפתח ברקע"
                )
                return jsonify({"ok": True, "provider": "browseros", "port": selected.cdp_port})
            if str(runtime.store.data.get("browser_provider") or "auto") == "browseros":
                raise RuntimeError(selected.error or "BrowserOS לא התחבר בזמן")

        profile_dir = Path(runtime.store.data["browser_profile_dir"])
        profile_dir.mkdir(parents=True, exist_ok=True)
        port = int(runtime.store.data.get("chrome_debug_port", 9223))
        profile_directory = str(runtime.store.data.get("chrome_profile_directory") or "Default")
        subprocess.Popen([
            chrome_executable(),
            f"--user-data-dir={profile_dir}",
            f"--profile-directory={profile_directory}",
            f"--remote-debugging-port={port}",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--hide-crash-restore-bubble",
            "--new-window",
            MAVAT_URL,
        ], cwd=str(ROOT_DIR))
        threading.Timer(2.0, runtime.ensure_chrome_preview).start()
        runtime.log(f"Chrome נפתח בדף השירות של מבא״ת עם הפרופיל {profile_directory}")
        return jsonify({"ok": True, "provider": "chrome", "port": port})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/chrome/status")
def api_chrome_status() -> Response:
    status = runtime.chrome_cdp_status()
    if status["connected"]:
        runtime.ensure_chrome_preview()
    return jsonify(status)


@app.get("/api/chrome/live")
def api_chrome_live() -> Response:
    status = runtime.chrome_cdp_status()
    if status["connected"]:
        runtime.ensure_chrome_preview()
    with runtime.lock:
        console_events = list(runtime.chrome_console_events[-40:])
    return jsonify({
        "chrome": status,
        "run": runtime.run_status(),
        "console": console_events,
        "server_time": datetime.now().isoformat(timespec="seconds"),
    })


@app.get("/api/chrome/preview.jpg")
def api_chrome_preview_image() -> Response:
    runtime.ensure_chrome_preview()
    with runtime.lock:
        frame = runtime.chrome_preview_frame
    if not frame:
        return jsonify({"ok": False, "error": runtime.chrome_preview_error or "התצוגה עדיין נטענת"}), 503
    response = Response(frame, mimetype="image/jpeg")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    if request.args.get("download") == "1":
        response.headers["Content-Disposition"] = f'attachment; filename="mavat-live-{datetime.now().strftime("%Y%m%d-%H%M%S")}.jpg"'
    return response


@app.post("/api/chrome/preview/select")
def api_chrome_preview_select() -> Response:
    target_id = str((request.get_json(force=True) or {}).get("target_id") or "")
    pages = runtime.chrome_cdp_status().get("pages", [])
    if target_id and not any(str(page.get("id")) == target_id for page in pages):
        return jsonify({"ok": False, "error": "הלשונית שנבחרה אינה זמינה יותר"}), 404
    runtime.chrome_preview_target_id = target_id
    runtime.chrome_preview_frame = b""
    runtime.stop_chrome_preview_process()
    return jsonify({"ok": True})


def suggested_step_from_detection(detected: dict[str, Any], action: str, sensitive: bool = False) -> dict[str, Any]:
    selectors = list(detected.get("selectors") or [])
    preferred = selectors[0] if selectors else {"strategy": "position", "value": "", "score": 45}
    position = detected.get("position") or {}
    fallbacks = selectors[1:] + [{
        "strategy": "position", "x_ratio": position.get("xRatio", 0.5),
        "y_ratio": position.get("yRatio", 0.5), "score": 40,
    }]
    label = str(detected.get("label") or detected.get("text") or detected.get("placeholder") or detected.get("tag") or "רכיב").strip()
    if len(label) > 120:
        label = f"{label[:117].rstrip()}..."
    is_secret = bool(detected.get("isSecret")) or sensitive
    is_choice = str(detected.get("role") or "").lower() in {"combobox", "listbox"} or bool(detected.get("isSelect"))
    is_fill = action == "type_text" or bool(detected.get("isField") and action == "inspect")
    if is_choice and not is_secret:
        step_type = "select_option"
        name = f"בחירה בשדה: {label}"
        value = "{TODO}"
    elif is_fill:
        step_type = "fill_secret" if is_secret else "smart_fill"
        name = "הזנת סיסמה" if is_secret else f"מילוי שדה: {label}"
        value = "" if is_secret else "{TODO}"
    else:
        step_type = "smart_click"
        name = f"לחיצה: {label}"
        value = ""
    return {
        "name": name, "type": step_type, "scope": "once", "target": label, "value": value,
        "timeout_seconds": 30, "enabled": True,
        "locator": preferred, "fallbacks": fallbacks,
        "page_url": str(detected.get("frameUrl") or ""),
        "position": {"x_ratio": position.get("xRatio", 0.5), "y_ratio": position.get("yRatio", 0.5)},
        "confidence": int(detected.get("confidence") or preferred.get("score") or 45),
        "recorded_at": datetime.now().isoformat(timespec="seconds"),
    }


@app.post("/api/chrome/interact")
def api_chrome_interact() -> Response:
    payload = request.get_json(force=True) or {}
    action = str(payload.get("action") or "")
    allowed = {"click", "double_click", "inspect", "scroll", "type_text", "key", "reload", "back", "forward"}
    if action not in allowed:
        return jsonify({"ok": False, "error": "פעולת דפדפן לא מוכרת"}), 400
    clean_payload = {
        "action": action,
        "x_ratio": max(0.0, min(1.0, float(payload.get("x_ratio") or 0.5))),
        "y_ratio": max(0.0, min(1.0, float(payload.get("y_ratio") or 0.5))),
        "delta_x": float(payload.get("delta_x") or 0),
        "delta_y": float(payload.get("delta_y") or 0),
        "key": str(payload.get("key") or "")[:50],
        "text": str(payload.get("text") or "")[:5000],
    }
    try:
        pages_before = {
            str(page.get("id"))
            for page in runtime.chrome_cdp_status().get("pages", [])
            if page.get("id")
        }
        if payload.get("record"):
            runtime.recorder_suppressed_until = time.time() + 2.5
        result = runtime.chrome_interact(clean_payload)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    if not result.get("ok"):
        return jsonify(result), 400
    if action in {"click", "double_click"}:
        pages_after = runtime.chrome_cdp_status().get("pages", [])
        opened = [page for page in pages_after if str(page.get("id") or "") not in pages_before]
        if opened:
            new_page = opened[0]
            runtime.chrome_preview_target_id = str(new_page.get("id") or "")
            runtime.chrome_preview_frame = b""
            runtime.stop_chrome_preview_process()
            result["switched_target"] = {
                "id": runtime.chrome_preview_target_id,
                "title": str(new_page.get("title") or ""),
                "url": str(new_page.get("url") or ""),
            }
    detected = result.get("detected")
    if payload.get("record") and isinstance(detected, dict):
        result["suggested_step"] = suggested_step_from_detection(
            detected, action, bool(payload.get("sensitive"))
        )
        if not payload.get("sensitive") and action in {"click", "double_click", "inspect"}:
            with runtime.lock:
                frame = runtime.chrome_preview_frame
            if frame:
                folder = ROOT_DIR / "screenshots" / "learning"
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / f"learn_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.jpg"
                path.write_bytes(frame)
                result["learning_screenshot"] = str(path.resolve())
    result.pop("id", None)
    return jsonify(result)


@app.post("/api/chrome/preview/toggle")
def api_chrome_preview_toggle() -> Response:
    runtime.chrome_preview_enabled = bool((request.get_json(force=True) or {}).get("enabled", True))
    if runtime.chrome_preview_enabled:
        runtime.ensure_chrome_preview()
    else:
        with runtime.lock:
            runtime.chrome_preview_frame = b""
        runtime.stop_chrome_preview_process()
    return jsonify({"ok": True, **runtime.chrome_preview_status()})


@app.post("/api/chrome/focus")
def api_chrome_focus() -> Response:
    if os.name != "nt":
        return jsonify({"ok": False, "error": "העברת Chrome לחזית נתמכת כרגע ב-Windows בלבד"}), 400
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        handles: list[tuple[int, str]] = []
        page_titles = {
            str(page.get("title") or "").strip()
            for page in runtime.chrome_cdp_status().get("pages", [])
            if str(page.get("title") or "").strip()
        }
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def collect(hwnd: int, _lparam: int) -> bool:
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name, 256)
            if user32.IsWindowVisible(hwnd) and class_name.value == "Chrome_WidgetWin_1":
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)
                if process:
                    try:
                        path_buffer = ctypes.create_unicode_buffer(1024)
                        path_size = wintypes.DWORD(len(path_buffer))
                        if ctypes.windll.kernel32.QueryFullProcessImageNameW(process, 0, path_buffer, ctypes.byref(path_size)):
                            if Path(path_buffer.value).name.casefold() == "chrome.exe":
                                title_buffer = ctypes.create_unicode_buffer(1024)
                                user32.GetWindowTextW(hwnd, title_buffer, 1024)
                                handles.append((hwnd, title_buffer.value))
                    finally:
                        ctypes.windll.kernel32.CloseHandle(process)
            return True

        user32.EnumWindows(callback_type(collect), 0)
        if not handles:
            return jsonify({"ok": False, "error": "לא נמצא חלון Chrome פתוח"}), 404
        matching = [
            item for item in handles
            if any(page_title in item[1] for page_title in page_titles)
        ]
        hwnd = (matching or handles)[0][0]
        user32.ShowWindow(hwnd, 9)
        user32.SetForegroundWindow(hwnd)
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
    runtime.ensure_chrome_console_monitor()
    log_path = runtime.log_path()
    application_log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    desktop_log_path = Path(os.environ.get("MAVAT_DESKTOP_LOG", ""))
    desktop_log = (
        desktop_log_path.read_text(encoding="utf-8", errors="replace")
        if desktop_log_path.is_file()
        else ""
    )
    cdp = runtime.chrome_cdp_status()
    connection_lines = [
        "=== מצב חיבורים ===",
        "ארכיטקטורה: BrowserOS מקומי מועדף עם MCP+CDP; Google Chrome ייעודי כגיבוי",
        "React: מחובר http://127.0.0.1:18474",
        f"Python: מחובר http://127.0.0.1:{WEB_PORT}",
        f"דפדפן פעיל: {cdp.get('display_name', 'דפדפן')} ({cdp.get('provider', 'לא ידוע')})",
        f"CDP: {'מחובר' if cdp['connected'] else 'מנותק'} http://127.0.0.1:{cdp['port']}",
        f"מנוע: {cdp['browser'] or 'לא זמין'} | פרופיל: {cdp['profile_directory']}",
        f"דפים פעילים: {len(cdp['pages'])} | אירועי Console: {len(runtime.chrome_console_events)}",
        "",
        "=== יומן מנוע Python ===",
        application_log or "היומן ריק.",
        "",
        "=== יומן Electron ולחיצות UI ===",
        desktop_log[-120000:] or "יומן Electron אינו זמין בהרצת דפדפן רגילה.",
        "",
        "=== Browser Console (CDP) ===",
    ]
    with runtime.lock:
        console_events = list(runtime.chrome_console_events)
    if console_events:
        connection_lines.extend(
            f"[{event['timestamp']}] [{event['level']}] {event['text']}\n  {event['url']}"
            for event in console_events
        )
    else:
        connection_lines.append("טרם נקלטו הודעות Console מהדפדפן.")
    return jsonify({"content": "\n".join(connection_lines), "connections": cdp})


@app.get("/api/logs/export.csv")
def api_export_logs() -> Response:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=["timestamp", "status", "message"])
    writer.writeheader()
    for event in reversed(parse_logs()):
        writer.writerow({key: event[key] for key in writer.fieldnames})
    data = io.BytesIO(output.getvalue().encode("utf-8-sig"))
    return send_file(data, mimetype="text/csv", as_attachment=True, download_name="mavat_run_report.csv")


def main() -> None:
    if "--no-browser" not in sys.argv:
        url = f"http://127.0.0.1:{WEB_PORT}/workflow"
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=WEB_PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
