from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Any

from .config import ConfigStore, LoginProfile
from .data_loader import load_records
from .recorder import BrowserRecorder
from .workflow import RunCallbacks, WorkflowRunner, load_workflow, save_workflow


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_WORKFLOW = ROOT_DIR / "workflow.json"
DEFAULT_TEMPLATE = ROOT_DIR / "outputs" / "mavat_clients_template.xlsx"
MAVAT_BOOKMARK_URL = "https://www.gov.il/he/service/mvat"

ACTION_TYPES = (
    "goto",
    "click_text",
    "click_role",
    "fill_label",
    "fill_placeholder",
    "select_option",
    "fill_secret",
    "wait_url",
    "wait_text",
    "manual",
    "screenshot",
    "delay",
    "noop",
)


class StepDialog(tk.Toplevel):
    def __init__(self, parent: tk.Misc, step: dict[str, Any] | None = None) -> None:
        super().__init__(parent)
        self.title("עריכת שלב")
        self.resizable(False, False)
        self.option_add("*TCombobox*Listbox.justify", "right")
        self.result: dict[str, Any] | None = None
        step = step or {}

        self.vars = {
            "name": tk.StringVar(value=step.get("name", "")),
            "type": tk.StringVar(value=step.get("type", "noop")),
            "scope": tk.StringVar(value=step.get("scope", "per_record")),
            "target": tk.StringVar(value=step.get("target", "")),
            "value": tk.StringVar(value=step.get("value", "")),
            "timeout_seconds": tk.StringVar(value=str(step.get("timeout_seconds", 30))),
            "enabled": tk.BooleanVar(value=step.get("enabled", True)),
        }
        labels = [
            ("שם השלב", "name"),
            ("סוג פעולה", "type"),
            ("היקף", "scope"),
            ("יעד/תווית", "target"),
            ("ערך/כתובת", "value"),
            ("זמן המתנה (שניות)", "timeout_seconds"),
        ]
        for row, (label, key) in enumerate(labels):
            ttk.Label(self, text=label).grid(row=row, column=1, padx=8, pady=6, sticky="e")
            if key == "type":
                widget = ttk.Combobox(self, textvariable=self.vars[key], values=ACTION_TYPES, state="readonly", width=42, justify="right")
            elif key == "scope":
                widget = ttk.Combobox(self, textvariable=self.vars[key], values=("once", "per_record"), state="readonly", width=42, justify="right")
            else:
                widget = ttk.Entry(self, textvariable=self.vars[key], width=45, justify="right")
            widget.grid(row=row, column=0, padx=8, pady=6, sticky="e")
        ttk.Checkbutton(self, text="שלב פעיל", variable=self.vars["enabled"]).grid(row=6, column=0, columnspan=2, pady=6, sticky="e")
        buttons = ttk.Frame(self)
        buttons.grid(row=7, column=0, columnspan=2, pady=10)
        ttk.Button(buttons, text="שמירה", command=self._save).pack(side="right", padx=5)
        ttk.Button(buttons, text="ביטול", command=self.destroy).pack(side="right", padx=5)
        self.transient(parent)
        self.grab_set()

    def _save(self) -> None:
        try:
            timeout = max(1, int(self.vars["timeout_seconds"].get()))
        except ValueError:
            messagebox.showerror("שגיאה", "זמן ההמתנה חייב להיות מספר", parent=self)
            return
        self.result = {
            "name": self.vars["name"].get().strip() or "שלב ללא שם",
            "type": self.vars["type"].get(),
            "scope": self.vars["scope"].get(),
            "target": self.vars["target"].get(),
            "value": self.vars["value"].get(),
            "timeout_seconds": timeout,
            "enabled": bool(self.vars["enabled"].get()),
        }
        self.destroy()


class PasswordDialog(tk.Toplevel):
    """Creates, links, replaces or clears a securely stored step password."""

    NEW_PROFILE = "➕ פרופיל חדש"

    def __init__(
        self,
        parent: tk.Misc,
        store: ConfigStore,
        step: dict[str, Any],
    ) -> None:
        super().__init__(parent)
        self.title("🔑 ניהול סיסמה לשלב")
        self.resizable(False, False)
        self.store = store
        self.step = step
        self.changed = False
        self.profile_map: dict[str, str] = {}

        self.profile_var = tk.StringVar()
        self.name_var = tk.StringVar()
        self.username_var = tk.StringVar()
        self.password_var = tk.StringVar()
        self.confirm_var = tk.StringVar()
        self.show_var = tk.BooleanVar(value=False)
        self.status_var = tk.StringVar(value="")

        profiles = self.store.profiles()
        values = [self.NEW_PROFILE]
        for profile in profiles:
            label = f"{profile.name} — {profile.username}"
            self.profile_map[label] = profile.id
            values.append(label)

        ttk.Label(self, text="פרופיל סיסמה", anchor="e").grid(row=0, column=2, padx=8, pady=7, sticky="e")
        self.profile_combo = ttk.Combobox(
            self, textvariable=self.profile_var, values=values,
            state="readonly", width=42, justify="right",
        )
        self.profile_combo.grid(row=0, column=0, columnspan=2, padx=8, pady=7, sticky="e")
        self.profile_combo.bind("<<ComboboxSelected>>", self._profile_changed)

        fields = [
            ("שם הפרופיל", self.name_var),
            ("שם משתמש / תעודת זהות", self.username_var),
        ]
        for row, (label, variable) in enumerate(fields, start=1):
            ttk.Label(self, text=label, anchor="e").grid(row=row, column=2, padx=8, pady=7, sticky="e")
            ttk.Entry(self, textvariable=variable, width=45, justify="right").grid(row=row, column=0, columnspan=2, padx=8, pady=7, sticky="e")

        ttk.Label(self, text="סיסמה חדשה", anchor="e").grid(row=3, column=2, padx=8, pady=7, sticky="e")
        self.password_entry = ttk.Entry(self, textvariable=self.password_var, show="•", width=45, justify="right")
        self.password_entry.grid(row=3, column=0, columnspan=2, padx=8, pady=7, sticky="e")
        ttk.Label(self, text="אימות סיסמה", anchor="e").grid(row=4, column=2, padx=8, pady=7, sticky="e")
        self.confirm_entry = ttk.Entry(self, textvariable=self.confirm_var, show="•", width=45, justify="right")
        self.confirm_entry.grid(row=4, column=0, columnspan=2, padx=8, pady=7, sticky="e")
        ttk.Checkbutton(self, text="הצג סיסמה", variable=self.show_var, command=self._toggle_show).grid(row=5, column=0, columnspan=3, padx=8, pady=4, sticky="e")
        ttk.Label(self, textvariable=self.status_var, foreground="#247A3D", anchor="e").grid(row=6, column=0, columnspan=3, padx=8, pady=5, sticky="e")

        buttons = ttk.Frame(self)
        buttons.grid(row=7, column=0, columnspan=3, padx=8, pady=12)
        ttk.Button(buttons, text="🔑 שמור וקשר לשלב", command=self._save).pack(side="right", padx=5)
        ttk.Button(buttons, text="מחק סיסמה", command=self._clear_password).pack(side="right", padx=5)
        ttk.Button(buttons, text="סגור", command=self.destroy).pack(side="right", padx=5)

        linked_id = str(step.get("credential_profile_id") or "")
        linked_label = next((label for label, pid in self.profile_map.items() if pid == linked_id), "")
        self.profile_var.set(linked_label or self.NEW_PROFILE)
        self._profile_changed()
        self.transient(parent)
        self.grab_set()

    def _selected_profile_id(self) -> str | None:
        return self.profile_map.get(self.profile_var.get())

    def _profile_changed(self, _event: object = None) -> None:
        profile_id = self._selected_profile_id()
        profile = next((p for p in self.store.profiles() if p.id == profile_id), None)
        if profile:
            self.name_var.set(profile.name)
            self.username_var.set(profile.username)
            self.status_var.set("🔒 סיסמה שמורה" if self.store.get_password(profile.id) else "🔑 אין סיסמה שמורה")
        else:
            self.name_var.set("")
            self.username_var.set("")
            self.status_var.set("יצירת פרופיל חדש")
        self.password_var.set("")
        self.confirm_var.set("")

    def _toggle_show(self) -> None:
        show = "" if self.show_var.get() else "•"
        self.password_entry.configure(show=show)
        self.confirm_entry.configure(show=show)

    def _save(self) -> None:
        password = self.password_var.get()
        if password != self.confirm_var.get():
            messagebox.showerror("סיסמה", "הסיסמאות אינן זהות", parent=self)
            return
        profile_id = self._selected_profile_id()
        try:
            profile = self.store.upsert_profile(
                self.name_var.get(),
                self.username_var.get(),
                password,
                profile_id=profile_id,
                persist_password=True,
            )
        except Exception as exc:
            messagebox.showerror("שמירת סיסמה", str(exc), parent=self)
            return
        self.step["credential_profile_id"] = profile.id
        self.changed = True
        self.status_var.set("🔒 הסיסמה נשמרה ב-Windows Credential Manager וקושרה לשלב")
        self.password_var.set("")
        self.confirm_var.set("")

    def _clear_password(self) -> None:
        profile_id = self._selected_profile_id()
        if not profile_id:
            messagebox.showinfo("סיסמה", "בחר פרופיל קיים", parent=self)
            return
        if not messagebox.askyesno("מחיקת סיסמה", "למחוק את הסיסמה השמורה מהכספת של Windows?", parent=self):
            return
        self.store.clear_password(profile_id)
        self.changed = True
        self.status_var.set("🔑 הסיסמה נמחקה")


class MavatApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("אוטומציית מבא״ת")
        self.geometry("1180x760")
        self.minsize(980, 650)
        self.option_add("*TCombobox*Listbox.justify", "right")
        self.store = ConfigStore()
        self.log_path = ROOT_DIR / "run_logs" / "automation.log"
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.records: list[dict[str, Any]] = []
        self.workflow_path = Path(self.store.data.get("workflow_file") or DEFAULT_WORKFLOW)
        self.workflow = load_workflow(self.workflow_path)
        self.runner: WorkflowRunner | None = None
        self.worker: threading.Thread | None = None
        self.recorder: BrowserRecorder | None = None
        self.recorder_worker: threading.Thread | None = None
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.selected_profile_id: str | None = None

        self._configure_style()
        self._build_ui()
        self._refresh_profiles()
        self._refresh_steps()
        self.after(100, self._drain_events)

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Title.TLabel", font=("Segoe UI", 19, "bold"), foreground="#143B63")
        style.configure("RTL.TLabel", anchor="e", justify="right")
        style.configure("RTL.TLabelframe.Label", anchor="e", justify="right")
        style.configure("RTL.TNotebook", tabposition="ne")
        style.configure("RTL.TNotebook.Tab", anchor="e", justify="right", padding=(14, 7))
        style.configure("Accent.TButton", font=("Segoe UI", 10, "bold"))
        style.configure("Treeview", rowheight=26, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", font=("Segoe UI", 10, "bold"), anchor="e")

    def _build_ui(self) -> None:
        header = ttk.Frame(self, padding=(18, 14))
        header.pack(fill="x")
        ttk.Label(header, text="מערכת אוטומציה למבא״ת", style="Title.TLabel", anchor="e", justify="right").pack(side="right")
        ttk.Label(header, text="פרופילים • נתונים • שלבים • בקרה", foreground="#5B6B7B", anchor="e", justify="right").pack(side="right", padx=20)

        self.tabs = ttk.Notebook(self, style="RTL.TNotebook")
        self.tabs.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        self.run_tab = ttk.Frame(self.tabs, padding=14)
        self.data_tab = ttk.Frame(self.tabs, padding=14)
        self.profile_tab = ttk.Frame(self.tabs, padding=14)
        self.steps_tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(self.run_tab, text="הפעלה")
        self.tabs.add(self.data_tab, text="נתוני לקוחות")
        self.tabs.add(self.profile_tab, text="פרופילי כניסה")
        self.tabs.add(self.steps_tab, text="שלבי עבודה")
        self._build_run_tab()
        self._build_data_tab()
        self._build_profiles_tab()
        self._build_steps_tab()

    def _build_run_tab(self) -> None:
        controls = ttk.LabelFrame(self.run_tab, text="הגדרות הרצה", padding=12)
        controls.pack(fill="x")
        controls.columnconfigure(0, weight=1)
        ttk.Label(controls, text="פרופיל כניסה:", anchor="e", justify="right").grid(row=0, column=3, sticky="e", padx=6, pady=6)
        self.run_profile = ttk.Combobox(controls, state="readonly", width=28, justify="right")
        self.run_profile.grid(row=0, column=2, sticky="e", padx=6, pady=6)
        self.dry_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls, text="מצב בדיקה בלבד (ללא שליחת נתונים)", variable=self.dry_var).grid(row=0, column=0, columnspan=2, padx=12, pady=6)
        self.chrome_email_var = tk.StringVar(value=self.store.data.get("chrome_account_email", ""))
        ttk.Label(controls, text="חשבון Chrome:", anchor="e", justify="right").grid(row=1, column=3, sticky="e", padx=6, pady=6)
        chrome_email = ttk.Entry(controls, textvariable=self.chrome_email_var, width=28, justify="right")
        chrome_email.grid(row=1, column=2, sticky="e", padx=6, pady=6)
        chrome_email.bind("<FocusOut>", lambda _event: self._save_chrome_email())
        self.open_chrome_btn = ttk.Button(controls, text="בדיקת Chrome בלבד", command=self._open_chrome_start)
        self.open_chrome_btn.grid(row=1, column=0, columnspan=2, padx=6, pady=6, sticky="e")
        self.start_btn = ttk.Button(controls, text="התחל – פתח Chrome", style="Accent.TButton", command=self._start_run)
        self.start_btn.grid(row=2, column=3, padx=6, pady=8)
        self.continue_btn = ttk.Button(controls, text="המשך אחרי פעולה ידנית", command=self._continue_run, state="disabled")
        self.continue_btn.grid(row=2, column=2, padx=6, pady=8)
        self.stop_btn = ttk.Button(controls, text="עצור", command=self._stop_run, state="disabled")
        self.stop_btn.grid(row=2, column=1, padx=6, pady=8)
        self.run_state = ttk.Label(controls, text="מוכן", foreground="#247A3D", anchor="e", justify="right")
        self.run_state.grid(row=2, column=0, padx=6, pady=8, sticky="e")

        log_frame = ttk.LabelFrame(self.run_tab, text="יומן ביצוע", padding=8)
        log_frame.pack(fill="both", expand=True, pady=(12, 0))
        self.log_text = tk.Text(log_frame, wrap="word", font=("Segoe UI", 10), bg="#F7F9FC", state="disabled")
        self.log_text.tag_configure("rtl", justify="right", rmargin=10, lmargin1=10, lmargin2=10)
        self.log_text.pack(fill="both", expand=True)

    def _build_data_tab(self) -> None:
        bar = ttk.Frame(self.data_tab)
        bar.pack(fill="x")
        self.data_path_var = tk.StringVar(value=self.store.data.get("last_data_file", ""))
        ttk.Entry(bar, textvariable=self.data_path_var, justify="right").pack(side="right", fill="x", expand=True, padx=(6, 0))
        ttk.Button(bar, text="בחירת Excel / Word", command=self._choose_data).pack(side="right", padx=6)
        ttk.Button(bar, text="פתח תבנית Excel", command=self._open_template).pack(side="right", padx=6)
        self.data_summary = ttk.Label(self.data_tab, text="טרם נטען קובץ", anchor="e", justify="right")
        self.data_summary.pack(anchor="e", pady=10)
        self.data_tree = ttk.Treeview(self.data_tab, show="headings")
        self.data_tree.pack(fill="both", expand=True)

    def _build_profiles_tab(self) -> None:
        form = ttk.LabelFrame(self.profile_tab, text="פרופיל כניסה", padding=12)
        form.pack(fill="x")
        self.profile_name = tk.StringVar()
        self.profile_user = tk.StringVar()
        self.profile_password = tk.StringVar()
        self.profile_password_status = tk.StringVar(value="לא נבחר פרופיל")
        self.persist_password = tk.BooleanVar(value=True)
        fields = [
            ("שם הפרופיל", self.profile_name, False),
            ("שם משתמש / תעודת זהות", self.profile_user, False),
            ("סיסמה", self.profile_password, True),
        ]
        for index, (label, variable, secret) in enumerate(fields):
            ttk.Label(form, text=label, anchor="e", justify="right").grid(row=index, column=2, padx=6, pady=6, sticky="e")
            ttk.Entry(form, textvariable=variable, show="•" if secret else "", width=42, justify="right").grid(row=index, column=1, padx=6, pady=6, sticky="e")
        ttk.Checkbutton(form, text="שמירה מאובטחת ב-Windows Credential Manager", variable=self.persist_password).grid(row=3, column=1, columnspan=2, sticky="e", pady=6)
        ttk.Label(form, textvariable=self.profile_password_status, foreground="#247A3D", anchor="e").grid(row=4, column=1, columnspan=2, sticky="e", pady=4)
        ttk.Button(form, text="שמירת פרופיל / החלפת סיסמה", command=self._save_profile).grid(row=5, column=2, padx=6, pady=8)
        ttk.Button(form, text="מחק סיסמה בלבד", command=self._clear_profile_password).grid(row=5, column=1, padx=6, pady=8, sticky="e")

        self.profile_tree = ttk.Treeview(self.profile_tab, columns=("name", "username", "password"), displaycolumns=("password", "username", "name"), show="headings", height=10)
        self.profile_tree.heading("name", text="שם פרופיל")
        self.profile_tree.heading("username", text="משתמש")
        self.profile_tree.heading("password", text="סיסמה")
        self.profile_tree.column("name", anchor="e")
        self.profile_tree.column("username", anchor="e")
        self.profile_tree.column("password", anchor="center", width=130)
        self.profile_tree.pack(fill="both", expand=True, pady=12)
        self.profile_tree.bind("<<TreeviewSelect>>", self._profile_selected)
        ttk.Button(self.profile_tab, text="מחיקת הפרופיל הנבחר", command=self._delete_profile).pack(anchor="e")

    def _build_steps_tab(self) -> None:
        record_bar = ttk.Frame(self.steps_tab)
        record_bar.pack(fill="x", pady=(0, 10))
        self.record_status = ttk.Label(record_bar, text="● ההקלטה כבויה", foreground="#7A7A7A", font=("Segoe UI", 11, "bold"))
        self.record_status.pack(side="right", padx=(8, 16))
        self.record_start_btn = ttk.Button(record_bar, text="התחל הקלטת פעולות", command=self._start_recording)
        self.record_start_btn.pack(side="right", padx=4)
        self.record_stop_btn = ttk.Button(record_bar, text="עצור הקלטה", command=self._stop_recording, state="disabled")
        self.record_stop_btn.pack(side="right", padx=4)
        ttk.Label(record_bar, text="לאחר ההפעלה עבור ל-Chrome ובצע את הפעולות.", foreground="#5B6B7B").pack(side="right", padx=12)

        self.steps_tree = ttk.Treeview(self.steps_tab, columns=("enabled", "secret", "name", "type", "scope", "target", "value"), show="headings", selectmode="extended")
        headings = {
            "enabled": "פעיל",
            "secret": "סיסמה",
            "name": "שם השלב",
            "type": "פעולה",
            "scope": "היקף",
            "target": "יעד/תווית",
            "value": "ערך/כתובת",
        }
        for key, label in headings.items():
            self.steps_tree.heading(key, text=label, anchor="e")
            self.steps_tree.column(key, anchor="center" if key == "secret" else "e", width=125 if key == "secret" else (115 if key not in {"name", "value"} else 240))
        self.steps_tree.configure(displaycolumns=("value", "target", "scope", "type", "name", "secret", "enabled"))
        self.steps_tree.pack(fill="both", expand=True)
        self.steps_tree.bind("<Double-1>", self._steps_double_click)
        self.steps_tree.bind("<Delete>", lambda _event: self._delete_steps())
        self.steps_tree.bind("<space>", lambda _event: self._toggle_selected_steps())
        buttons = ttk.Frame(self.steps_tab)
        buttons.pack(fill="x", pady=10)
        for text, command in (
            ("הוסף לפני", lambda: self._add_step("before")),
            ("הוסף אחרי", lambda: self._add_step("after")),
            ("עריכת שלב", self._edit_step),
            ("🔑 ניהול סיסמה", self._manage_step_password),
            ("מחק נבחרים", self._delete_steps),
            ("השהה נבחרים", lambda: self._set_selected_enabled(False)),
            ("הפעל נבחרים", lambda: self._set_selected_enabled(True)),
            ("למעלה", lambda: self._move_step(-1)),
            ("למטה", lambda: self._move_step(1)),
            ("שמירת שלבים", self._save_steps),
        ):
            ttk.Button(buttons, text=text, command=command).pack(side="right", padx=4)
        ttk.Label(self.steps_tab, text="בתבניות ערך ניתן להשתמש בשדות כגון {client_name}, {id_number}, {block}, {parcel}, {username}.", foreground="#5B6B7B").pack(anchor="e")

    def _start_recording(self) -> None:
        if self.recorder_worker and self.recorder_worker.is_alive():
            messagebox.showinfo("הקלטה", "הקלטת הפעולות כבר פעילה")
            return
        port = int(self.store.data.get("chrome_debug_port", 9223))
        self.recorder = BrowserRecorder(
            port,
            on_log=lambda text: self.events.put(("log", text)),
            on_step=lambda step: self.events.put(("recorded_step", step)),
            on_started=lambda text: self.events.put(("recording_started", text)),
            on_finished=lambda text: self.events.put(("recording_finished", text)),
        )
        self.recorder_worker = threading.Thread(target=self.recorder.run, daemon=True)
        self.recorder_worker.start()
        self.record_status.configure(text="● מתחבר ל-Chrome...", foreground="#B05A00")
        self.record_start_btn.configure(state="disabled")
        self.record_stop_btn.configure(state="normal")
        self._append_log("מתחבר ל-Chrome לצורך הקלטה...")

    def _stop_recording(self) -> None:
        if self.recorder:
            self.record_status.configure(text="● עוצר הקלטה...", foreground="#B05A00")
            self.recorder.stop()

    def _choose_data(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("קובצי נתונים", "*.xlsx *.csv *.tsv *.docx"), ("כל הקבצים", "*.*")])
        if not path:
            return
        self.data_path_var.set(path)
        self._load_data(path)

    def _load_data(self, path: str) -> None:
        try:
            self.records = load_records(path)
        except Exception as exc:
            messagebox.showerror("שגיאת קובץ", str(exc))
            return
        self.store.data["last_data_file"] = path
        self.store.save()
        self._show_records()

    def _show_records(self) -> None:
        self.data_tree.delete(*self.data_tree.get_children())
        columns = [key for key in (self.records[0].keys() if self.records else []) if not key.startswith("_")]
        self.data_tree.configure(columns=columns)
        for col in columns:
            self.data_tree.heading(col, text=col, anchor="e")
            self.data_tree.column(col, width=140, anchor="e")
        self.data_tree.configure(displaycolumns=tuple(reversed(columns)))
        for row in self.records[:250]:
            self.data_tree.insert("", "end", values=[row.get(col, "") for col in columns])
        self.data_summary.configure(text=f"נטענו {len(self.records)} רשומות | מוצגות עד 250 רשומות")

    def _open_template(self) -> None:
        if not DEFAULT_TEMPLATE.exists():
            messagebox.showwarning("תבנית", "תבנית Excel עדיין לא נוצרה")
            return
        os.startfile(DEFAULT_TEMPLATE)

    def _refresh_profiles(self) -> None:
        self.profile_tree.delete(*self.profile_tree.get_children())
        profiles = self.store.profiles()
        for profile in profiles:
            has_password = bool(self.store.get_password(profile.id))
            self.profile_tree.insert("", "end", iid=profile.id, values=(profile.name, profile.username, "••••••" if has_password else "לא נשמרה"))
        self.run_profile["values"] = [p.name for p in profiles]
        if profiles and not self.run_profile.get():
            self.run_profile.current(0)

    def _save_profile(self) -> None:
        try:
            profile = self.store.upsert_profile(
                self.profile_name.get(), self.profile_user.get(), self.profile_password.get(),
                self.selected_profile_id, self.persist_password.get(),
            )
        except RuntimeError as exc:
            messagebox.showwarning("שמירת סיסמה", str(exc))
        except Exception as exc:
            messagebox.showerror("שגיאה", str(exc))
            return
        else:
            self.selected_profile_id = profile.id
            self.profile_password_status.set("🔒 סיסמה שמורה" if self.store.get_password(profile.id) else "🔑 אין סיסמה שמורה")
        self.profile_password.set("")
        self._refresh_profiles()

    def _profile_selected(self, _event: object = None) -> None:
        selected = self.profile_tree.selection()
        if not selected:
            return
        self.selected_profile_id = selected[0]
        profile = next((p for p in self.store.profiles() if p.id == self.selected_profile_id), None)
        if profile:
            self.profile_name.set(profile.name)
            self.profile_user.set(profile.username)
            self.profile_password.set("")
            self.profile_password_status.set("🔒 סיסמה שמורה" if self.store.get_password(profile.id) else "🔑 אין סיסמה שמורה")

    def _clear_profile_form(self) -> None:
        self.selected_profile_id = None
        self.profile_name.set("")
        self.profile_user.set("")
        self.profile_password.set("")
        self.profile_password_status.set("לא נבחר פרופיל")
        self.profile_tree.selection_remove(self.profile_tree.selection())

    def _clear_profile_password(self) -> None:
        if not self.selected_profile_id:
            messagebox.showinfo("סיסמה", "בחר פרופיל מהרשימה")
            return
        if not messagebox.askyesno("מחיקת סיסמה", "למחוק רק את הסיסמה השמורה?"):
            return
        self.store.clear_password(self.selected_profile_id)
        self.profile_password_status.set("🔑 הסיסמה נמחקה")
        self._refresh_profiles()

    def _delete_profile(self) -> None:
        selected = self.profile_tree.selection()
        if not selected or not messagebox.askyesno("מחיקה", "למחוק את הפרופיל והסיסמה השמורה?"):
            return
        self.store.delete_profile(selected[0])
        self._clear_profile_form()
        self._refresh_profiles()

    def _refresh_steps(self, selected: list[int] | None = None) -> None:
        self.steps_tree.delete(*self.steps_tree.get_children())
        for index, step in enumerate(self.workflow.get("steps", [])):
            value = "••••••" if step.get("type") == "fill_secret" else step.get("value", "")
            secret_status = ""
            if step.get("type") == "fill_secret":
                profile_id = str(step.get("credential_profile_id") or "")
                if profile_id:
                    secret_status = "🔒 שמורה" if self.store.get_password(profile_id) else "🔑 חסרה"
                else:
                    secret_status = "🔑 הגדרה"
            self.steps_tree.insert("", "end", iid=str(index), values=("כן" if step.get("enabled", True) else "לא", secret_status, step.get("name", ""), step.get("type", ""), step.get("scope", ""), step.get("target", ""), value))
        for index in selected or []:
            if self.steps_tree.exists(str(index)):
                self.steps_tree.selection_add(str(index))

    def _selected_step_indices(self) -> list[int]:
        return sorted(int(item) for item in self.steps_tree.selection())

    def _selected_step_index(self) -> int | None:
        selection = self._selected_step_indices()
        return selection[0] if selection else None

    def _steps_double_click(self, event: tk.Event) -> None:
        row_id = self.steps_tree.identify_row(event.y)
        if not row_id:
            return
        self.steps_tree.selection_set(row_id)
        step = self.workflow["steps"][int(row_id)]
        if step.get("type") == "fill_secret":
            self._manage_step_password()
        else:
            self._edit_step()

    def _manage_step_password(self) -> None:
        selected = self._selected_step_indices()
        if len(selected) != 1:
            messagebox.showinfo("ניהול סיסמה", "בחר שלב סיסמה אחד")
            return
        index = selected[0]
        step = self.workflow["steps"][index]
        if step.get("type") != "fill_secret":
            messagebox.showinfo("ניהול סיסמה", "הפעולה שנבחרה אינה מסוג fill_secret")
            return
        dialog = PasswordDialog(self, self.store, step)
        self.wait_window(dialog)
        if dialog.changed:
            save_workflow(self.workflow_path, self.workflow)
            self._refresh_profiles()
            self._refresh_steps([index])

    def _add_step(self, position: str = "after") -> None:
        dialog = StepDialog(self)
        self.wait_window(dialog)
        if dialog.result:
            selected = self._selected_step_indices()
            if not selected:
                insert_at = len(self.workflow["steps"])
            elif position == "before":
                insert_at = selected[0]
            else:
                insert_at = selected[-1] + 1
            self.workflow["steps"].insert(insert_at, dialog.result)
            self._refresh_steps([insert_at])
            save_workflow(self.workflow_path, self.workflow)

    def _edit_step(self) -> None:
        selected = self._selected_step_indices()
        if len(selected) != 1:
            messagebox.showinfo("עריכת שלב", "יש לבחור פעולה אחת בלבד לעריכה")
            return
        index = selected[0]
        dialog = StepDialog(self, self.workflow["steps"][index])
        self.wait_window(dialog)
        if dialog.result:
            self.workflow["steps"][index] = dialog.result
            self._refresh_steps()
            self.steps_tree.selection_set(str(index))
            save_workflow(self.workflow_path, self.workflow)

    def _delete_steps(self) -> None:
        selected = self._selected_step_indices()
        if not selected:
            return
        if not messagebox.askyesno("מחיקת פעולות", f"למחוק {len(selected)} פעולות שנבחרו?"):
            return
        for index in reversed(selected):
            del self.workflow["steps"][index]
        self._refresh_steps()
        save_workflow(self.workflow_path, self.workflow)

    def _set_selected_enabled(self, enabled: bool) -> None:
        selected = self._selected_step_indices()
        for index in selected:
            self.workflow["steps"][index]["enabled"] = enabled
        self._refresh_steps(selected)
        if selected:
            save_workflow(self.workflow_path, self.workflow)

    def _toggle_selected_steps(self) -> None:
        selected = self._selected_step_indices()
        if not selected:
            return
        should_enable = any(not self.workflow["steps"][i].get("enabled", True) for i in selected)
        self._set_selected_enabled(should_enable)

    def _move_step(self, delta: int) -> None:
        selected = self._selected_step_indices()
        if not selected:
            return
        if delta < 0 and selected[0] == 0:
            return
        if delta > 0 and selected[-1] == len(self.workflow["steps"]) - 1:
            return
        order = selected if delta < 0 else list(reversed(selected))
        for index in order:
            target = index + delta
            self.workflow["steps"][index], self.workflow["steps"][target] = self.workflow["steps"][target], self.workflow["steps"][index]
        moved = [index + delta for index in selected]
        self._refresh_steps(moved)
        save_workflow(self.workflow_path, self.workflow)

    def _save_steps(self) -> None:
        save_workflow(self.workflow_path, self.workflow)
        self.store.data["workflow_file"] = str(self.workflow_path)
        self.store.save()
        messagebox.showinfo("שלבים", "רשימת השלבים נשמרה")

    def _selected_profile(self) -> LoginProfile | None:
        name = self.run_profile.get()
        return next((p for p in self.store.profiles() if p.name == name), None)

    def _save_chrome_email(self) -> None:
        self.store.data["chrome_account_email"] = self.chrome_email_var.get().strip()
        self.store.save()

    @staticmethod
    def _chrome_executable() -> str:
        candidates = [
            shutil.which("chrome.exe"),
            str(Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe"),
            str(Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe"),
            str(Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"),
        ]
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return candidate
        raise FileNotFoundError("Google Chrome אינו מותקן או שלא נמצא במיקום הרגיל")

    def _open_chrome_start(self) -> None:
        try:
            chrome = self._chrome_executable()
            profile_dir = Path(self.store.data["browser_profile_dir"])
            profile_dir.mkdir(parents=True, exist_ok=True)
            port = int(self.store.data.get("chrome_debug_port", 9223))
            self._save_chrome_email()
            subprocess.Popen(
                [
                    chrome,
                    f"--user-data-dir={profile_dir}",
                    f"--profile-directory={self.store.data.get('chrome_profile_directory', 'Default')}",
                    f"--remote-debugging-port={port}",
                    "--remote-allow-origins=*",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-session-crashed-bubble",
                    "--hide-crash-restore-bubble",
                    "--new-window",
                    MAVAT_BOOKMARK_URL,
                ],
                cwd=str(ROOT_DIR),
            )
            expected = self.chrome_email_var.get().strip()
            note = f" ודא שהחשבון המחובר הוא {expected}." if expected else ""
            self._append_log("שלב 1: Chrome נפתח ישירות לכתובת הסימנייה של מבא״ת." + note)
            self.run_state.configure(text="Chrome פתוח", foreground="#247A3D")
        except Exception as exc:
            messagebox.showerror("פתיחת Chrome", str(exc))

    def _start_run(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        if self.data_path_var.get() and not self.records:
            self._load_data(self.data_path_var.get())
        profile = self._selected_profile()
        if not profile:
            self._open_chrome_start()
            messagebox.showinfo(
                "השלב הראשון הופעל",
                "Chrome נפתח בדף מבא״ת. כדי להמשיך אחר כך למילוי אוטומטי, צור פרופיל כניסה בכרטיסייה 'פרופילי כניסה'.",
            )
            return
        if not self.records:
            self._open_chrome_start()
            messagebox.showinfo(
                "השלב הראשון הופעל",
                "Chrome נפתח בדף מבא״ת. כדי להמשיך אחר כך למילוי אוטומטי, בחר קובץ בכרטיסייה 'נתוני לקוחות'.",
            )
            return
        password = self.store.get_password(profile.id)
        callbacks = RunCallbacks(
            log=lambda text: self.events.put(("log", text)),
            status=lambda row, status, note: self.events.put(("status", (row, status, note))),
            manual=lambda text: self.events.put(("manual", text)),
            finished=lambda text: self.events.put(("finished", text)),
        )
        self.runner = WorkflowRunner(
            self.workflow, self.records, profile.username, password,
            profile.id,
            {item.id: self.store.get_password(item.id) for item in self.store.profiles()},
            self.store.data["browser_profile_dir"],
            int(self.store.data.get("chrome_debug_port", 9223)),
            callbacks, self.dry_var.get(),
        )
        self.worker = threading.Thread(target=self.runner.run, daemon=True)
        self.worker.start()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.run_state.configure(text="פועל...", foreground="#B05A00")
        self._append_log("--- התחלת הרצה ---")

    def _stop_run(self) -> None:
        if self.runner:
            self.runner.stop()
        self.run_state.configure(text="עוצר...")

    def _continue_run(self) -> None:
        if self.runner:
            self.runner.continue_after_manual()
        self.continue_btn.configure(state="disabled")

    def _append_log(self, text: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", "\u200f" + text + "\n", "rtl")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"[{timestamp}] {text}\n")

    def _drain_events(self) -> None:
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "log":
                    self._append_log(str(payload))
                elif kind == "manual":
                    self._append_log("נדרשת פעולה ידנית: " + str(payload))
                    self.continue_btn.configure(state="normal")
                    messagebox.showinfo("פעולה ידנית", str(payload))
                elif kind == "status":
                    row, status, note = payload
                    self._append_log(f"שורה {row}: {status} {note}")
                elif kind == "finished":
                    self._append_log(str(payload))
                    self.run_state.configure(text=str(payload), foreground="#247A3D")
                    self.start_btn.configure(state="normal")
                    self.stop_btn.configure(state="disabled")
                    self.continue_btn.configure(state="disabled")
                elif kind == "recorded_step":
                    self.workflow["steps"].append(payload)
                    self._refresh_steps()
                    save_workflow(self.workflow_path, self.workflow)
                elif kind == "recording_started":
                    self.record_status.configure(text="● מקליט עכשיו", foreground="#C62828")
                    self.record_start_btn.configure(state="disabled")
                    self.record_stop_btn.configure(state="normal")
                    self._append_log(str(payload))
                    messagebox.showinfo("הקלטה", "ההקלטה פעילה. עבור ל-Chrome ובצע את הפעולות.")
                elif kind == "recording_finished":
                    self._append_log(str(payload))
                    save_workflow(self.workflow_path, self.workflow)
                    self.recorder = None
                    failed = str(payload).startswith("ההקלטה נכשלה")
                    self.record_status.configure(
                        text="● ההקלטה נכשלה" if failed else "● ההקלטה כבויה",
                        foreground="#C62828" if failed else "#7A7A7A",
                    )
                    self.record_start_btn.configure(state="normal")
                    self.record_stop_btn.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(100, self._drain_events)


def main() -> None:
    app = MavatApp()
    app.mainloop()
