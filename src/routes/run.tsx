import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Camera,
  ChevronDown,
  ChevronUp,
  Chrome,
  ClipboardCopy,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Focus,
  Keyboard,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  Save,
  Square,
  Terminal,
  TestTube2,
  Wifi,
  WifiOff,
  X,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { AutomationContext } from "@/components/automation-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  copyMavatText,
  mavatApi,
  type RunState,
  type SettingsData,
  type WorkflowData,
  type WorkflowStep,
} from "@/lib/mavat-api";

export const Route = createFileRoute("/run")({ component: RunPage });

type ChromePage = { id: string; title: string; url: string };
type PreviewState = {
  enabled: boolean;
  available: boolean;
  target_id: string;
  url: string;
  title: string;
  error: string;
  updated_at: string;
  frames: number;
};
type ConsoleEvent = { timestamp: string; level: string; text: string; url: string };
export type LiveData = {
  chrome: {
    connected: boolean;
    browser: string;
    port: number;
    profile_directory: string;
    pages: ChromePage[];
    preview: PreviewState;
  };
  run: RunState;
  console: ConsoleEvent[];
  server_time: string;
};

const stateLabels: Record<string, string> = {
  idle: "מוכן",
  running: "פועל",
  paused: "מושהה",
  manual: "ממתין לפעולה ידנית",
  stopping: "עוצר",
  error: "שגיאה",
};

function RunPage() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [profiles, setProfiles] = useState<WorkflowData["profiles"]>({});
  const [profileId, setProfileId] = useState("");
  const [dry, setDry] = useState(false);
  const [live, setLive] = useState<LiveData | null>(null);
  const [fullPreview, setFullPreview] = useState(false);
  const [consoleText, setConsoleText] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  const loadBase = async () => {
    const [s, w] = await Promise.all([
      mavatApi<SettingsData>("/api/settings"),
      mavatApi<WorkflowData>("/api/workflow"),
    ]);
    setSettings(s);
    setProfiles(w.profiles);
    setProfileId((current) => current || Object.keys(w.profiles)[0] || "");
  };
  const loadLive = async () => {
    try {
      setLive(await mavatApi<LiveData>("/api/chrome/live"));
    } catch {
      /* transient while services start */
    }
  };
  useEffect(() => {
    loadBase();
    loadLive();
    const liveTimer = setInterval(loadLive, 900);
    const baseTimer = setInterval(loadBase, 5000);
    return () => {
      clearInterval(liveTimer);
      clearInterval(baseTimer);
    };
  }, []);

  const state = live?.run || settings?.run;
  const running = ["running", "paused", "manual", "stopping"].includes(state?.state || "");
  const progress = state?.total_rows ? Math.round((state.current_row / state.total_rows) * 100) : 0;
  const preview = live?.chrome.preview;
  const recentConsole = useMemo(
    () => [...(live?.console || [])].reverse().slice(0, 8),
    [live?.console],
  );

  const postAction = async (name: "start" | "stop" | "continue" | "pause" | "resume") => {
    setBusy(name);
    try {
      const init: RequestInit = { method: "POST" };
      if (name === "start") init.body = JSON.stringify({ profile_id: profileId, dry_run: dry });
      const result = await mavatApi<{ message?: string }>(`/api/run/${name}`, init);
      toast.success(result.message || "הפעולה בוצעה");
      await Promise.all([loadLive(), loadBase()]);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const chromeAction = async (name: "open" | "focus") => {
    try {
      await mavatApi(`/api/chrome/${name}`, { method: "POST" });
      toast.success(name === "open" ? "Chrome נפתח בדף מבא״ת" : "Chrome הועבר לחזית");
      setTimeout(loadLive, 1200);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const togglePreview = async () => {
    try {
      await mavatApi("/api/chrome/preview/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: !preview?.enabled }),
      });
      await loadLive();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const selectTab = async (targetId: string) => {
    try {
      await mavatApi("/api/chrome/preview/select", {
        method: "POST",
        body: JSON.stringify({ target_id: targetId }),
      });
      await loadLive();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const openConsole = async () => {
    const data = await mavatApi<{ content: string }>("/api/console");
    setConsoleText(data.content || "");
  };
  const copyDiagnostics = async () => {
    const report = {
      generated_at: new Date().toISOString(),
      chrome: live?.chrome,
      run: state,
      console: live?.console?.slice(-40),
    };
    await copyMavatText(JSON.stringify(report, null, 2));
    toast.success("דוח האבחון הועתק");
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-7">
      <AutomationContext />
      <PageHeader
        eyebrow="מרכז שליטה חי"
        title="הפעלה ותצוגת אוטומציה"
        description="צפה בדיוק במה ש-Chrome מבצע, שלוט בהרצה וקבל אבחון מלא בזמן אמת."
        actions={
          <>
            <Button variant="outline" onClick={() => chromeAction("open")}>
              <Chrome className="size-4" />
              פתח Chrome
            </Button>
            <Button
              variant="outline"
              onClick={() => chromeAction("focus")}
              disabled={!live?.chrome.connected}
            >
              <Focus className="size-4" />
              העבר לחזית
            </Button>
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatusTile
          icon={live?.chrome.connected ? Wifi : WifiOff}
          label="חיבור Chrome"
          value={live?.chrome.connected ? "מחובר" : "מנותק"}
          good={live?.chrome.connected}
          detail={`Google Chrome חיצוני · CDP ${live?.chrome.port || 9223}`}
        />
        <StatusTile
          icon={TestTube2}
          label="מצב הרצה"
          value={stateLabels[state?.state || "idle"] || state?.state || "מוכן"}
          good={state?.state === "running"}
          detail={state?.message || "אין הרצה פעילה"}
        />
        <StatusTile
          icon={Monitor}
          label="לשונית פעילה"
          value={preview?.title || "לא נבחרה"}
          good={preview?.available}
          detail={
            preview?.updated_at
              ? `עודכן ${new Date(preview.updated_at).toLocaleTimeString("he-IL")}`
              : "ממתין לתמונה"
          }
        />
        <StatusTile
          icon={Camera}
          label="מסגרות שנקלטו"
          value={String(preview?.frames || 0)}
          good={Boolean(preview?.frames)}
          detail={`פרופיל ${live?.chrome.profile_directory || "—"}`}
        />
      </section>

      <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.75fr)_420px]">
        <LivePreview
          live={live}
          full={fullPreview}
          onFull={() => setFullPreview((value) => !value)}
          onToggle={togglePreview}
          onSelect={selectTab}
          onFocus={() => chromeAction("focus")}
        />

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-xl">בקרת ההרצה</CardTitle>
              <CardDescription>מקור נתונים, חשבון ומצב ביצוע</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="size-4 text-accent" />
                  <strong className="truncate text-sm">
                    {settings?.data_file_name || "לא נבחר קובץ נתונים"}
                  </strong>
                </div>
              </div>
              <label className="block space-y-2 text-sm font-medium">
                פרופיל כניסה
                <select
                  className="h-10 w-full rounded-md border bg-background px-3"
                  value={profileId}
                  onChange={(event) => setProfileId(event.target.value)}
                >
                  {!Object.keys(profiles).length && <option value="">לא הוגדר פרופיל</option>}
                  {Object.entries(profiles).map(([id, profile]) => (
                    <option key={id} value={id}>
                      {profile.name} · {profile.username} {profile.has_password ? "🔒" : "🔑"}
                    </option>
                  ))}
                </select>
              </label>
              <div
                className={`flex items-center justify-between rounded-md border p-3 ${dry ? "border-accent/40 bg-accent/5" : "border-emerald-500/40 bg-emerald-500/5"}`}
              >
                <div>
                  <p className="text-sm font-medium">
                    {dry ? "מצב בדיקה בלבד" : "הרצה אמיתית ב-Chrome"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {dry ? "ללא שליחת נתונים" : "הפעולות יבוצעו באתר בפועל"}
                  </p>
                </div>
                <Switch checked={dry} onCheckedChange={setDry} disabled={running} />
              </div>
              {!running && (
                <Button
                  className="w-full"
                  onClick={() => postAction("start")}
                  disabled={busy === "start"}
                >
                  <Play className="size-4" />
                  {dry ? "התחל בדיקה" : "התחל אוטומציה אמיתית"}
                </Button>
              )}
              {running && (
                <div className="grid grid-cols-2 gap-2">
                  {state?.state === "running" && (
                    <Button variant="outline" onClick={() => postAction("pause")}>
                      <Pause className="size-4" />
                      השהה
                    </Button>
                  )}
                  {state?.state === "paused" && (
                    <Button onClick={() => postAction("resume")}>
                      <Play className="size-4" />
                      המשך
                    </Button>
                  )}
                  {state?.state === "manual" && (
                    <Button onClick={() => postAction("continue")}>
                      <Play className="size-4" />
                      בוצע — המשך
                    </Button>
                  )}
                  <Button variant="destructive" onClick={() => postAction("stop")}>
                    <Square className="size-4" />
                    עצור
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card
            className={
              state?.state === "manual"
                ? "border-accent"
                : state?.state === "error"
                  ? "border-destructive"
                  : ""
            }
          >
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="font-display text-xl">השלב הנוכחי</CardTitle>
                <Badge variant={state?.state === "error" ? "destructive" : "secondary"}>
                  {stateLabels[state?.state || "idle"] || state?.state}
                </Badge>
              </div>
              <CardDescription>{state?.message || "מוכן להפעלה"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={progress} />
              <div className="grid grid-cols-3 gap-2 text-center">
                <MiniStat
                  label="רשומה"
                  value={`${state?.current_row || 0}/${state?.total_rows || 0}`}
                />
                <MiniStat label="שלב" value={String(state?.current_step || 0)} />
                <MiniStat label="פעולה" value={state?.current_step_action || "—"} mono />
              </div>
              {state?.current_step_name && (
                <div className="rounded-md border bg-muted/40 p-3">
                  <strong>{state.current_step_name}</strong>
                  {state.current_step_target && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      יעד: {state.current_step_target}
                    </p>
                  )}
                </div>
              )}
              {state?.state === "manual" && (
                <div className="rounded-md border border-accent bg-accent/10 p-3 text-sm">
                  <strong>נדרשת פעולה ידנית</strong>
                  <p className="mt-1 text-muted-foreground">{state.manual_message}</p>
                </div>
              )}
              {state?.last_error?.error && <ErrorCard state={state} />}
            </CardContent>
          </Card>
        </div>
      </section>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 font-display text-xl">
                <Terminal className="size-5 text-accent" />
                קונסול חי
              </CardTitle>
              <CardDescription>הודעות Chrome האחרונות; מידע רגיש אינו נכתב ליומן.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={loadLive}>
                <RefreshCw className="size-4" />
                רענן
              </Button>
              <Button variant="outline" size="sm" onClick={copyDiagnostics}>
                <ClipboardCopy className="size-4" />
                העתק אבחון
              </Button>
              <Button size="sm" onClick={openConsole}>
                <Terminal className="size-4" />
                קונסול מלא
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div
            className="max-h-72 overflow-auto rounded-md bg-slate-950 p-4 font-mono text-xs text-slate-200"
            dir="ltr"
          >
            {recentConsole.length ? (
              recentConsole.map((event, index) => (
                <div
                  key={`${event.timestamp}-${index}`}
                  className="border-b border-slate-800 py-2 last:border-0"
                >
                  <span
                    className={
                      event.level === "error" || event.level === "pageerror"
                        ? "text-red-400"
                        : event.level === "warning"
                          ? "text-amber-300"
                          : "text-sky-300"
                    }
                  >
                    [{event.level}]
                  </span>{" "}
                  <span>{event.text}</span>
                  <div className="truncate text-slate-500">{event.url}</div>
                </div>
              ))
            ) : (
              <p className="text-slate-500">טרם נקלטו הודעות Console.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {consoleText !== null && (
        <ConsoleModal content={consoleText} onClose={() => setConsoleText(null)} />
      )}
    </div>
  );
}

type SmartCandidate = {
  detected?: { confidence?: number; text?: string; label?: string; role?: string };
  suggested_step?: WorkflowStep;
  learning_screenshot?: string;
};

export function LivePreview({
  live,
  full,
  onFull,
  onToggle,
  onSelect,
  onFocus,
  onStepSaved,
}: {
  live: LiveData | null;
  full: boolean;
  onFull: () => void;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onFocus: () => void;
  onStepSaved?: () => void | Promise<void>;
}) {
  const preview = live?.chrome.preview;
  const imageRef = useRef<HTMLImageElement>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelDelta = useRef({ x: 0, y: 0, point: { x_ratio: 0.5, y_ratio: 0.5 } });
  const [control, setControl] = useState(false);
  const [learning, setLearning] = useState(false);
  const [inspectNext, setInspectNext] = useState(false);
  const [typing, setTyping] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [candidate, setCandidate] = useState<SmartCandidate | null>(null);
  const [working, setWorking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const interact = async (payload: Record<string, unknown>) => {
    setWorking(true);
    try {
      const result = await mavatApi<SmartCandidate & { ok: boolean }>("/api/chrome/interact", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          record: learning || payload["action"] === "inspect",
          sensitive,
        }),
      });
      if (result.suggested_step) setCandidate(result);
      return result;
    } catch (error) {
      toast.error((error as Error).message);
      return undefined;
    } finally {
      setWorking(false);
    }
  };
  const coordinates = (clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    const naturalRatio = image.naturalWidth / Math.max(1, image.naturalHeight);
    const boxRatio = rect.width / Math.max(1, rect.height);
    const shownWidth = naturalRatio > boxRatio ? rect.width : rect.height * naturalRatio;
    const shownHeight = naturalRatio > boxRatio ? rect.width / naturalRatio : rect.height;
    const left = rect.left + (rect.width - shownWidth) / 2;
    const top = rect.top + (rect.height - shownHeight) / 2;
    return {
      x_ratio: Math.max(0, Math.min(1, (clientX - left) / shownWidth)),
      y_ratio: Math.max(0, Math.min(1, (clientY - top) / shownHeight)),
    };
  };
  const clickImage = (event: React.MouseEvent<HTMLImageElement>) => {
    if (!control && !learning && !inspectNext) return;
    const point = coordinates(event.clientX, event.clientY);
    if (!point) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      interact({ action: inspectNext ? "inspect" : "click", ...point });
      setInspectNext(false);
    }, 230);
  };
  const doubleClickImage = (event: React.MouseEvent<HTMLImageElement>) => {
    if (!control && !learning) return;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    const point = coordinates(event.clientX, event.clientY);
    if (point) interact({ action: "double_click", ...point });
  };
  const queueScroll = (
    point: { x_ratio: number; y_ratio: number },
    deltaX: number,
    deltaY: number,
  ) => {
    wheelDelta.current.x += deltaX;
    wheelDelta.current.y += deltaY;
    wheelDelta.current.point = point;
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => {
      const pending = wheelDelta.current;
      wheelDelta.current = { x: 0, y: 0, point: pending.point };
      void interact({
        action: "scroll",
        ...pending.point,
        delta_x: Math.max(-1200, Math.min(1200, pending.x)),
        delta_y: Math.max(-1200, Math.min(1200, pending.y)),
      });
    }, 120);
  };
  const saveCandidate = async () => {
    if (!candidate?.suggested_step) return;
    const step = {
      ...candidate.suggested_step,
      ...(candidate.learning_screenshot
        ? { screenshot: candidate.learning_screenshot }
        : {}),
    };
    await mavatApi("/api/steps", {
      method: "POST",
      body: JSON.stringify({ step }),
    });
    await onStepSaved?.();
    toast.success("הפעולה נוספה לסוף שלבי העבודה");
    setCandidate(null);
  };
  const sendText = async () => {
    if (!typing) return;
    await interact({ action: "type_text", text: typing });
    setTyping("");
  };

  return (
    <Card
      className={
        full
          ? "fixed inset-4 z-50 flex flex-col overflow-hidden border-slate-700 bg-slate-950 text-white shadow-2xl"
          : "overflow-hidden"
      }
    >
      <CardHeader className="border-b pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-display text-xl">
              <span
                className={`size-2.5 rounded-full ${live?.chrome.connected ? "animate-pulse bg-emerald-500" : "bg-destructive"}`}
              />
              תצוגה חיה מ־Chrome החיצוני
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={full ? "border-slate-600 text-slate-300" : ""}>
                צילום CDP · לא iframe
              </Badge>
              <CardDescription className={full ? "text-slate-400" : ""}>
                {preview?.title || "ממתין לחיבור לדפדפן"}
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCollapsed((value) => !value)}
              title={collapsed ? "הרחב תצוגה חיה" : "מזער תצוגה חיה"}
              aria-label={collapsed ? "הרחב תצוגה חיה" : "מזער תצוגה חיה"}
            >
              {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
              {collapsed ? "הרחב" : "מזער"}
            </Button>
            {!collapsed && (
              <>
            <Button
              variant={control ? "default" : "outline"}
              size="sm"
              onClick={() => setControl((value) => !value)}
            >
              <MousePointer2 className="size-4" />
              {control ? "שליטה פעילה" : "אפשר שליטה"}
            </Button>
            <Button
              variant={learning ? "destructive" : "outline"}
              size="sm"
              onClick={() => {
                setLearning((value) => !value);
                setControl(true);
              }}
            >
              <span
                className={`size-2 rounded-full ${learning ? "animate-pulse bg-white" : "bg-destructive"}`}
              />
              {learning ? "מקליט פעולות" : "מצב לימוד"}
            </Button>
            <Button variant="outline" size="sm" onClick={onToggle}>
              {preview?.enabled ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              {preview?.enabled ? "הסתר" : "הצג"}
            </Button>
            <Button variant="outline" size="icon" onClick={onFull}>
              {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
              </>
            )}
          </div>
        </div>
        {!collapsed && (
          <>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            title="אחורה"
            onClick={() => interact({ action: "back" })}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="קדימה"
            onClick={() => interact({ action: "forward" })}
          >
            <Redo2 className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="רענון"
            onClick={() => interact({ action: "reload" })}
          >
            <RefreshCw className="size-4" />
          </Button>
          <select
            className={`h-9 min-w-0 flex-1 rounded-md border px-3 text-sm ${full ? "border-slate-700 bg-slate-900" : "bg-background"}`}
            value={preview?.target_id || ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">בחירה אוטומטית של לשונית מבא״ת</option>
            {(live?.chrome.pages || []).map((page) => (
              <option key={page.id} value={page.id}>
                {page.title || page.url}
              </option>
            ))}
          </select>
          <Button
            variant={inspectNext ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setInspectNext(true);
              setControl(true);
            }}
          >
            <Focus className="size-4" />
            סמן רכיב
          </Button>
          <Button variant="outline" size="sm" onClick={onFocus}>
            <Chrome className="size-4" />
            Chrome
          </Button>
          {preview?.available && (
            <Button variant="outline" size="sm" asChild>
              <a href="/api/chrome/preview.jpg?download=1">
                <Download className="size-4" />
                צילום
              </a>
            </Button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className={`h-9 min-w-48 flex-1 rounded-md border px-3 text-sm ${full ? "border-slate-700 bg-slate-900" : "bg-background"}`}
            type={sensitive ? "password" : "text"}
            value={typing}
            onChange={(event) => setTyping(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendText();
            }}
            placeholder="הקלדה לשדה הפעיל..."
          />
          <Button size="sm" onClick={sendText} disabled={!typing || working}>
            <Keyboard className="size-4" />
            הקלד
          </Button>
          <Button
            variant={sensitive ? "destructive" : "outline"}
            size="sm"
            onClick={() => setSensitive((value) => !value)}
          >
            <LockKeyhole className="size-4" />
            {sensitive ? "מידע רגיש" : "רגיל"}
          </Button>
          {["Tab", "Enter", "Backspace", "Escape"].map((key) => (
            <Button
              key={key}
              variant="outline"
              size="sm"
              onClick={() => interact({ action: "key", key })}
            >
              {key}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              interact({ action: "scroll", delta_y: -650, x_ratio: 0.5, y_ratio: 0.5 })
            }
          >
            <ArrowUp className="size-4" />
            גלול למעלה
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => interact({ action: "scroll", delta_y: 650, x_ratio: 0.5, y_ratio: 0.5 })}
          >
            <ArrowDown className="size-4" />
            גלול למטה
          </Button>
        </div>
        {preview?.url && (
          <div
            className={`mt-3 flex items-center gap-2 rounded-md px-3 py-2 font-mono text-xs ${full ? "bg-slate-900 text-slate-400" : "bg-muted text-muted-foreground"}`}
            dir="ltr"
          >
            <span className="truncate">{preview.url}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ms-auto size-7"
              onClick={() => copyMavatText(preview.url)}
            >
              <ClipboardCopy className="size-3.5" />
            </Button>
          </div>
        )}
          </>
        )}
      </CardHeader>
      {!collapsed && (
        <CardContent
          className={`relative grid place-items-center p-0 ${full ? "min-h-0 flex-1" : "aspect-video bg-slate-950"}`}
          onWheel={(event) => {
            if (!control && !learning) return;
            event.preventDefault();
            const point = coordinates(event.clientX, event.clientY);
            if (point) queueScroll(point, event.deltaX, event.deltaY);
          }}
        >
        {preview?.enabled && preview.available ? (
          <img
            ref={imageRef}
            className={`h-full w-full object-contain ${control || learning || inspectNext ? "cursor-crosshair" : ""}`}
            src={`/api/chrome/preview.jpg?v=${preview.frames}`}
            alt="תצוגה חיה של Chrome"
            draggable={false}
            onClick={clickImage}
            onDoubleClick={doubleClickImage}
          />
        ) : (
          <div className="p-10 text-center text-slate-400">
            {preview?.enabled ? (
              <>
                <Monitor className="mx-auto mb-4 size-12 opacity-40" />
                <p>{preview.error || "מפעיל תצוגה חיה..."}</p>
              </>
            ) : (
              <>
                <EyeOff className="mx-auto mb-4 size-12 opacity-40" />
                <p>התצוגה והצילום כבויים לשמירת פרטיות</p>
              </>
            )}
          </div>
        )}
        {preview?.enabled && preview.available && (
          <div className="absolute bottom-3 right-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white">
            <span className="size-2 animate-pulse rounded-full bg-red-500" />
            {working ? "מבצע..." : learning ? "חי · לימוד" : control ? "חי · שליטה" : "חי"}
          </div>
        )}
        </CardContent>
      )}
      {!collapsed && candidate?.suggested_step && (
        <div className={`border-t p-4 ${full ? "border-slate-700 bg-slate-900" : "bg-accent/5"}`}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">
                פעולה שנקלטה · אמינות {candidate.suggested_step.confidence || 0}%
              </p>
              <strong className="block truncate">{candidate.suggested_step.name}</strong>
              <p className="truncate text-xs text-muted-foreground">
                {candidate.suggested_step.type} · {candidate.suggested_step.target}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setCandidate(null)}>
              <X className="size-4" />
              התעלם
            </Button>
            <Button size="sm" onClick={saveCandidate}>
              <Save className="size-4" />
              שמור כשלב
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ErrorCard({ state }: { state: RunState }) {
  const error = state.last_error!;
  return (
    <div className="rounded-md border border-destructive bg-destructive/5 p-3">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <strong>שלב {error.step} נכשל</strong>
          <p className="mt-1 text-sm text-destructive">{error.error}</p>
          <p className="mt-2 truncate font-mono text-xs text-muted-foreground" dir="ltr">
            {error.url}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyMavatText(JSON.stringify(error, null, 2))}
        >
          <ClipboardCopy className="size-4" />
          העתק כשל
        </Button>
        {error.screenshot && (
          <Button variant="outline" size="sm" asChild>
            <a href="/api/run/error-screenshot" target="_blank">
              <Camera className="size-4" />
              צילום הכשל
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
function StatusTile({
  icon: Icon,
  label,
  value,
  detail,
  good,
}: {
  icon: typeof Monitor;
  label: string;
  value: string;
  detail: string;
  good: boolean | undefined;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div
          className={`rounded-md p-2 ${good ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <strong className="block truncate">{value}</strong>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}
function MiniStat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md bg-muted/60 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <strong className={`block truncate text-sm ${mono ? "font-mono" : ""}`}>{value}</strong>
    </div>
  );
}
function ConsoleModal({ content, onClose }: { content: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/70 p-5 backdrop-blur-sm">
      <section className="flex h-[min(800px,calc(100vh-40px))] w-[min(1200px,calc(100vw-40px))] flex-col rounded-xl border border-slate-700 bg-slate-950 p-5 text-slate-100 shadow-2xl">
        <header className="mb-4 flex items-center justify-between border-b border-slate-700 pb-4">
          <div>
            <p className="text-xs tracking-[.2em] text-slate-400">PYTHON · CHROME CDP · REACT</p>
            <h2 className="font-display text-2xl">קונסול ואבחון מלא</h2>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => copyMavatText(content)}>
              <ClipboardCopy className="size-4" />
              העתק הכל
            </Button>
            <Button variant="secondary" size="icon" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </header>
        <pre
          className="flex-1 overflow-auto rounded-md border border-slate-800 bg-black/40 p-4 text-left font-mono text-sm leading-6 text-sky-100"
          dir="ltr"
        >
          {content || "הקונסול ריק."}
        </pre>
      </section>
    </div>
  );
}
