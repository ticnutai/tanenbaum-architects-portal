import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  command,
  connectStored,
  discoverBackend,
  eventSocket,
  forgetConnection,
  loadState,
  loadThumbnail,
  pair,
  type Connection,
  type ExtensionState,
  type ExtensionStep,
} from "./api";

type Status = "scanning" | "pairing" | "connected" | "offline";

function actionLabel(type: string) {
  const labels: Record<string, string> = {
    goto: "מעבר",
    click: "לחיצה",
    click_role: "לחיצה",
    click_text: "לחיצה",
    fill: "מילוי",
    fill_label: "מילוי",
    fill_placeholder: "מילוי",
    fill_secret: "סיסמה",
    select: "בחירה",
    manual: "ידני",
    wait_text: "המתנה",
    screenshot: "צילום",
  };
  return labels[type] || type;
}

function StepCard({
  step,
  connection,
  onChanged,
}: {
  step: ExtensionStep;
  connection: Connection;
  onChanged: (state: ExtensionState) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(step.name);
  const [thumbnail, setThumbnail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(step.name), [step.name]);
  useEffect(
    () => () => {
      if (thumbnail) URL.revokeObjectURL(thumbnail);
    },
    [thumbnail],
  );

  const runAction = async (action: string, body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await command<{ state: ExtensionState }>(
        connection,
        `/api/extension/steps/${step.index}/${action}`,
        body,
      );
      onChanged(result.state);
      setMenuOpen(false);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleThumbnail = async () => {
    if (thumbnail) {
      URL.revokeObjectURL(thumbnail);
      setThumbnail("");
      return;
    }
    setBusy(true);
    try {
      setThumbnail(await loadThumbnail(connection, step.index));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={`step-card ${step.enabled ? "" : "step-paused"}`}
      data-testid="recorded-step"
    >
      <div className="step-row">
        <span className="step-number">{step.index + 1}</span>
        <div className="step-main">
          {editing ? (
            <form
              className="rename-row"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction("rename", { name });
              }}
            >
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                maxLength={180}
              />
              <button type="submit" disabled={busy || !name.trim()}>
                שמור
              </button>
              <button type="button" className="quiet" onClick={() => setEditing(false)}>
                ביטול
              </button>
            </form>
          ) : (
            <>
              <strong>{step.name}</strong>
              <span className="step-detail" title={step.target || step.page_url}>
                {step.type === "fill_secret"
                  ? step.secret_status === "saved"
                    ? "סיסמה שמורה בכספת"
                    : "נדרשת סיסמה בכספת"
                  : step.target || step.value || step.page_url || "פעולה מוקלטת"}
              </span>
            </>
          )}
        </div>
        <span className={`type-pill ${step.type === "manual" ? "manual" : ""}`}>
          {actionLabel(step.type)}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={`פעולות עבור ${step.name}`}
          title="פעולות"
          onClick={() => setMenuOpen((value) => !value)}
        >
          ⋮
        </button>
      </div>
      <div className="step-meta">
        <span>{step.locator_strategy}</span>
        {step.confidence ? <span>דיוק {step.confidence}%</span> : null}
        {!step.enabled ? <span className="paused-label">מושהה</span> : null}
      </div>
      {menuOpen ? (
        <div className="step-actions">
          <button onClick={() => setEditing(true)}>עריכה</button>
          <button onClick={() => void runAction("duplicate")} disabled={busy}>
            שכפול
          </button>
          <button onClick={() => void runAction(step.enabled ? "pause" : "resume")} disabled={busy}>
            {step.enabled ? "השהיה" : "הפעלה"}
          </button>
          {step.has_screenshot ? (
            <button onClick={() => void toggleThumbnail()}>
              {thumbnail ? "הסתר צילום" : "הצג צילום"}
            </button>
          ) : null}
          <button
            className="danger"
            disabled={busy}
            onClick={() => window.confirm(`למחוק את „${step.name}”?`) && void runAction("delete")}
          >
            מחיקה
          </button>
        </div>
      ) : null}
      {thumbnail ? (
        <img className="thumbnail" src={thumbnail} alt={`צילום של ${step.name}`} />
      ) : null}
    </article>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>("scanning");
  const [port, setPort] = useState(18473);
  const [code, setCode] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [state, setState] = useState<ExtensionState | null>(null);
  const [message, setMessage] = useState("מחפש את תוכנת מבא״ת המקומית...");
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);

  const refresh = useCallback(async (activeConnection: Connection) => {
    const next = await loadState(activeConnection);
    setState((current) => (current && current.revision > next.revision ? current : next));
    setStatus("connected");
  }, []);

  const connectEvents = useCallback(
    (activeConnection: Connection) => {
      socketRef.current?.close();
      const socket = eventSocket(activeConnection);
      socketRef.current = socket;
      socket.onopen = () => {
        reconnectAttempt.current = 0;
        setMessage("מחובר למנוע ההקלטה");
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string };
          if (payload.type === "authentication-required") {
            void forgetConnection();
            setConnection(null);
            setState(null);
            setStatus("pairing");
            setMessage("יש לחבר מחדש את התוסף");
            return;
          }
          if (payload.type !== "heartbeat") void refresh(activeConnection);
        } catch {
          // An invalid diagnostic event should not break the side panel.
        }
      };
      socket.onclose = () => {
        if (socketRef.current !== socket || !activeConnection) return;
        const delay = Math.min(10_000, 1000 * 2 ** reconnectAttempt.current++);
        setMessage("החיבור הופסק זמנית — מתחבר מחדש...");
        reconnectRef.current = window.setTimeout(() => connectEvents(activeConnection), delay);
      };
    },
    [refresh],
  );

  const initialize = useCallback(async () => {
    setStatus("scanning");
    setMessage("מחפש את תוכנת מבא״ת המקומית...");
    try {
      const stored = await connectStored();
      if (stored) {
        setConnection(stored.connection);
        setState(stored.state);
        setPort(stored.connection.port);
        setStatus("connected");
        connectEvents(stored.connection);
        return;
      }
      const backend = await discoverBackend();
      setPort(backend.port);
      setStatus("pairing");
      setMessage("התוכנה נמצאה — נדרש קוד חיבור חד־פעמי");
    } catch (error) {
      setStatus("offline");
      setMessage(error instanceof Error ? error.message : "לא ניתן להתחבר לתוכנה");
    }
  }, [connectEvents]);

  useEffect(() => {
    void initialize();
    return () => {
      socketRef.current = null;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
    };
  }, [initialize]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "z" && connection) {
        event.preventDefault();
        void command<{ state: ExtensionState }>(connection, "/api/extension/steps/undo").then(
          (result) => setState(result.state),
        );
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [connection]);

  const orderedSteps = useMemo(() => [...(state?.steps || [])].reverse(), [state?.steps]);
  const recording = state?.recording.state === "recording";

  const pairNow = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    setBusy(true);
    try {
      const result = await pair(port, code);
      setConnection(result.connection);
      setState(result.state);
      setStatus("connected");
      setMessage("התוסף חובר בהצלחה");
      setCode("");
      connectEvents(result.connection);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "החיבור נכשל");
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async (path: string) => {
    if (!connection) return;
    setBusy(true);
    try {
      const result = await command<{ state?: ExtensionState; message?: string }>(connection, path);
      if (result.state) setState(result.state);
      if (result.message) setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "הפעולה נכשלה");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">מ</div>
        <div>
          <h1>מקליט מבא״ת</h1>
          <p>{status === "connected" ? state?.automation.name : "סיידבר עבודה חי"}</p>
        </div>
        <span
          className={`connection-dot ${status === "connected" ? "online" : ""}`}
          title={message}
        />
      </header>

      {status !== "connected" ? (
        <main className="setup-card">
          <span className="setup-icon">◉</span>
          <h2>
            {status === "offline"
              ? "התוכנה אינה מחוברת"
              : status === "pairing"
                ? "חיבור חד־פעמי"
                : "מתחבר..."}
          </h2>
          <p>{message}</p>
          {status === "pairing" ? (
            <form onSubmit={pairNow} className="pair-form">
              <label htmlFor="pair-code">קוד שמופיע בהגדרות התוכנה</label>
              <input
                id="pair-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                pattern="\d{6}"
                placeholder="000000"
                autoFocus
                dir="ltr"
              />
              <button type="submit" className="primary" disabled={busy || code.length !== 6}>
                {busy ? "מחבר..." : "חיבור לתוכנה"}
              </button>
            </form>
          ) : (
            <button type="button" className="primary" onClick={() => void initialize()}>
              בדיקה מחדש
            </button>
          )}
        </main>
      ) : (
        <>
          <section className="status-strip">
            <div>
              <span className={`record-dot ${recording ? "active" : ""}`} />
              <strong>{recording ? "מקליט עכשיו" : "הקלטה כבויה"}</strong>
            </div>
            <span className={state?.browser.connected ? "browser-ok" : "browser-offline"}>
              {state?.browser.connected ? `${state.browser.display_name} מחובר` : "הדפדפן מנותק"}
            </span>
          </section>

          <section className="controls">
            <button
              className={recording ? "stop" : "primary"}
              disabled={busy}
              onClick={() =>
                void runCommand(`/api/extension/recording/${recording ? "stop" : "start"}`)
              }
            >
              {recording ? "■ עצירת הקלטה" : "● התחלת הקלטה"}
            </button>
            <button
              disabled={busy || !state?.steps.length}
              onClick={() => void runCommand("/api/extension/steps/undo")}
              title="Ctrl+Z"
            >
              ↶ ביטול אחרון
            </button>
            <button onClick={() => void runCommand("/api/extension/open-editor")}>
              פתיחת העורך
            </button>
          </section>

          <section className="page-context">
            <small>העמוד הפעיל</small>
            <strong>{state?.browser.target_title || "ממתין לעמוד בדפדפן"}</strong>
            {state?.browser.target_url ? <span dir="ltr">{state.browser.target_url}</span> : null}
          </section>

          <div className="steps-heading">
            <div>
              <h2>שלבים שהוקלטו</h2>
              <p>{message}</p>
            </div>
            <span>{state?.steps.length || 0}</span>
          </div>

          <main className="steps-list" aria-live="polite">
            {orderedSteps.length ? (
              orderedSteps.map((step) => (
                <StepCard
                  key={`${step.index}-${step.recorded_at}-${step.name}`}
                  step={step}
                  connection={connection!}
                  onChanged={setState}
                />
              ))
            ) : (
              <div className="empty-state">
                <span>⌁</span>
                <strong>עדיין אין שלבים</strong>
                <p>לחץ על „התחלת הקלטה” ועבוד כרגיל באתר. כל פעולה תופיע כאן מיד.</p>
              </div>
            )}
          </main>
        </>
      )}
    </div>
  );
}
