from __future__ import annotations

import csv
import io
import json
import os
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
        self.current_step = 0
        self.current_step_name = ""
        self.last_error: dict[str, Any] = {}
        self.chrome_import_thread: threading.Thread | None = None
        self.chrome_import_state = "idle"
        self.chrome_import_message = "טרם בוצע ייבוא מ-Chrome"
        self.chrome_import_current = 0
        self.chrome_import_total = 0
        self.chrome_import_warnings: list[str] = []
        self.chrome_console_events: list[dict[str, Any]] = []
        self.chrome_console_monitor_thread: threading.Thread | None = None
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
        port = int(self.store.data.get("chrome_debug_port", 9222))
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as response:
                version = json.load(response)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                targets = json.load(response)
            pages = [item for item in targets if item.get("type") == "page" and str(item.get("url", "")).startswith("http")]
            return {
                "connected": True,
                "browser": str(version.get("Browser") or "Chrome"),
                "port": port,
                "pages": [{"title": str(item.get("title") or ""), "url": str(item.get("url") or "")} for item in pages],
                "profile_directory": str(self.store.data.get("chrome_profile_directory") or "Default"),
                "console_events": len(self.chrome_console_events),
            }
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            return {
                "connected": False, "browser": "", "port": port, "pages": [],
                "profile_directory": str(self.store.data.get("chrome_profile_directory") or "Default"),
                "console_events": len(self.chrome_console_events),
            }

    def ensure_chrome_console_monitor(self) -> None:
        if self.chrome_console_monitor_thread and self.chrome_console_monitor_thread.is_alive():
            return

        def monitor() -> None:
            try:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as playwright:
                    browser = playwright.chromium.connect_over_cdp(
                        f"http://127.0.0.1:{int(self.store.data.get('chrome_debug_port', 9222))}", timeout=5000
                    )
                    attached: set[int] = set()

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

                    while browser.is_connected():
                        for context in browser.contexts:
                            for page in context.pages:
                                if id(page) in attached:
                                    continue
                                page.on("console", lambda message, current=page: append_event(message.type, message.text, current.url))
                                page.on("pageerror", lambda error, current=page: append_event("pageerror", str(error), current.url))
                                attached.add(id(page))
                        time.sleep(0.5)
            except Exception as exc:
                self.log(f"ניטור Console של Chrome נותק: {exc}")

        self.chrome_console_monitor_thread = threading.Thread(target=monitor, daemon=True)
        self.chrome_console_monitor_thread.start()

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
            return load_workflow(self.workflow_path())

    def write_workflow(self, workflow: dict[str, Any]) -> None:
        with self.lock:
            save_workflow(self.workflow_path(), workflow)

    def log(self, message: str) -> None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        path = self.log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, path.open("a", encoding="utf-8") as handle:
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
            "current_step": self.current_step,
            "current_step_name": self.current_step_name,
            "last_error": self.last_error,
        }

    def start_run(self, profile_id: str, dry_run: bool) -> tuple[bool, str]:
        if self.runner_thread and self.runner_thread.is_alive():
            return False, "כבר מתבצעת הרצה"
        profiles = {profile.id: profile for profile in self.store.profiles()}
        profile = profiles.get(profile_id)
        if not profile:
            return False, "יש לבחור פרופיל כניסה"
        data_file, _ = self.active_data_file()
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
        self.current_step = 0
        self.current_step_name = ""
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
            if state == "running":
                self.run_message = f"מבצע שלב {step_number}: {name}"

        def run_error(details: dict[str, Any]) -> None:
            self.last_error = details
            self.run_state = "error"
            self.run_message = f"שלב {details.get('step')} נכשל: {details.get('step_name')}"

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
            callbacks=RunCallbacks(log=self.log, status=status, manual=manual, finished=finished, step=step_status, error=run_error),
            dry_run=dry_run,
            chrome_profile_directory=str(self.store.data.get("chrome_profile_directory") or "Default"),
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
    return redirect(url_for("workflow_page"))


@app.get("/workflow")
def workflow_page() -> str:
    return render_template("workflow.html", active="workflow")


@app.get("/runs")
def runs_page() -> str:
    return render_template("runs.html", active="runs")


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
    return jsonify({
        "data_file": data_path,
        "data_file_name": data_name or (Path(data_path).name if data_path else ""),
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


@app.get("/api/run/error-screenshot")
def api_run_error_screenshot() -> Response:
    path = Path(str(runtime.last_error.get("screenshot") or ""))
    if not path.is_file():
        return jsonify({"ok": False, "error": "לא נמצא צילום כשל"}), 404
    return send_file(path, mimetype="image/png")


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
        profile_dir = Path(runtime.store.data["browser_profile_dir"])
        profile_dir.mkdir(parents=True, exist_ok=True)
        port = int(runtime.store.data.get("chrome_debug_port", 9222))
        profile_directory = str(runtime.store.data.get("chrome_profile_directory") or "Default")
        subprocess.Popen([
            chrome_executable(),
            f"--user-data-dir={profile_dir}",
            f"--profile-directory={profile_directory}",
            f"--remote-debugging-port={port}",
            "--remote-allow-origins=*",
            "--new-window",
            MAVAT_URL,
        ], cwd=str(ROOT_DIR))
        threading.Timer(2.0, runtime.ensure_chrome_console_monitor).start()
        runtime.log(f"Chrome נפתח בדף השירות של מבא״ת עם הפרופיל {profile_directory}")
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/chrome/status")
def api_chrome_status() -> Response:
    status = runtime.chrome_cdp_status()
    if status["connected"]:
        runtime.ensure_chrome_console_monitor()
    return jsonify(status)


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
    log_path = runtime.log_path()
    application_log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    cdp = runtime.chrome_cdp_status()
    connection_lines = [
        "=== מצב חיבורים ===",
        "React: מחובר http://127.0.0.1:18474",
        "Python: מחובר http://127.0.0.1:18473",
        f"Chrome CDP: {'מחובר' if cdp['connected'] else 'מנותק'} http://127.0.0.1:{cdp['port']}",
        f"Chrome: {cdp['browser'] or 'לא זמין'} | פרופיל: {cdp['profile_directory']}",
        f"דפים פעילים: {len(cdp['pages'])} | אירועי Console: {len(runtime.chrome_console_events)}",
        "",
        "=== יומן מנוע Python ===",
        application_log or "היומן ריק.",
        "",
        "=== Chrome Console (CDP) ===",
    ]
    with runtime.lock:
        console_events = list(runtime.chrome_console_events)
    if console_events:
        connection_lines.extend(
            f"[{event['timestamp']}] [{event['level']}] {event['text']}\n  {event['url']}"
            for event in console_events
        )
    else:
        connection_lines.append("טרם נקלטו הודעות Console מ-Chrome.")
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
