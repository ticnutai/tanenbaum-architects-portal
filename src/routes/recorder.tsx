import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Camera, Chrome, ListChecks, MousePointer2, Radio, ShieldCheck, Square, Wrench } from "lucide-react";
import { toast } from "sonner";

import { AutomationContext } from "@/components/automation-context";
import { PageHeader } from "@/components/page-header";
import { RecordedStepsPanel } from "@/components/recorded-steps-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { mavatApi, type WorkflowData } from "@/lib/mavat-api";
import { LivePreview, type LiveData } from "@/routes/run";

export const Route = createFileRoute("/recorder")({ component: RecorderPage });

function RecorderPage() {
  const [data, setData] = useState<WorkflowData>({
    workflow: { name: "", steps: [] },
    profiles: {},
  });
  const [recording, setRecording] = useState({
    state: "idle",
    message: "ההקלטה כבויה",
    transport: "raw-cdp-websocket",
    background: true,
  });
  const [live, setLive] = useState<LiveData | null>(null);
  const [fullPreview, setFullPreview] = useState(false);
  const [backgroundConnected, setBackgroundConnected] = useState(false);
  const [chromeBusy, setChromeBusy] = useState(false);
  const [secureAuthMessage, setSecureAuthMessage] = useState("");

  const loadWorkflow = useCallback(async () => {
    setData(await mavatApi<WorkflowData>("/api/workflow"));
  }, []);
  const loadRecording = useCallback(async () => {
    setRecording(await mavatApi("/api/recording/status"));
  }, []);
  const loadLive = useCallback(async () => {
    try {
      setLive(await mavatApi<LiveData>("/api/chrome/live"));
    } catch {
      // Chrome and Python may briefly reconnect while the desktop app starts.
    }
  }, []);
  const refresh = useCallback(
    async () => Promise.all([loadWorkflow(), loadRecording(), loadLive()]),
    [loadLive, loadRecording, loadWorkflow],
  );

  const waitForChrome = useCallback(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await mavatApi<{ connected: boolean }>("/api/chrome/status");
      if (status.connected) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Chrome נפתח אך חיבור CDP לא הושלם בזמן");
  }, []);

  const ensureChrome = useCallback(
    async (notify = false) => {
      const status = await mavatApi<{ connected: boolean }>("/api/chrome/status");
      if (!status.connected) {
        // The Python backend owns provider selection: BrowserOS when its MCP
        // and CDP endpoints are healthy, otherwise the dedicated Chrome.
        await mavatApi("/api/chrome/open", { method: "POST" });
        await waitForChrome();
      }
      await loadLive();
      if (notify) toast.success("דפדפן האוטומציה מחובר ומוכן");
    },
    [loadLive, waitForChrome],
  );

  useEffect(() => {
    void refresh().catch((error) => toast.error(error.message));
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    socket.onopen = () => setBackgroundConnected(true);
    socket.onclose = () => setBackgroundConnected(false);
    socket.onerror = () => setBackgroundConnected(false);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type?: string; message?: string };
        if (event.type === "secure-auth-detected") {
          const notice = event.message || "נדרש אישור בדיאלוג המאובטח; לאחר הבחירה התהליך ימשיך אוטומטית";
          setSecureAuthMessage(notice);
          toast.info(notice, { duration: 10000 });
        }
        if (
          [
            "connected",
            "step-recorded",
            "recording-status",
            "recording-target",
            "chrome-console",
            "secure-auth-detected",
          ].includes(event.type || "")
        ) {
          void refresh();
        }
      } catch {
        // Ignore malformed diagnostic messages; the connection remains active.
      }
    };
    const fallbackTimer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(fallbackTimer);
      socket.close();
    };
  }, [refresh]);

  useEffect(() => {
    // Entering the recorder restores the selected local browser provider in
    // the background without forcing a Chrome window to the foreground.
    if (!window.mavatDesktop?.automationEngine) return;
    setChromeBusy(true);
    void ensureChrome()
      .catch((error) => toast.error(`פתיחת דפדפן האוטומציה נכשלה: ${error.message}`))
      .finally(() => setChromeBusy(false));
  }, [ensureChrome]);

  const record = async (action: "start" | "stop") => {
    try {
      if (action === "start") {
        setChromeBusy(true);
        await ensureChrome();
      }
      const result = await mavatApi<{ message: string }>(`/api/recording/${action}`, {
        method: "POST",
      });
      toast(result.message);
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setChromeBusy(false);
    }
  };
  const togglePreview = async () => {
    await mavatApi("/api/chrome/preview/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled: !live?.chrome.preview.enabled }),
    });
    await loadLive();
  };
  const selectPreviewTab = async (targetId: string) => {
    await mavatApi("/api/chrome/preview/select", {
      method: "POST",
      body: JSON.stringify({ target_id: targetId }),
    });
    await loadLive();
  };
  const focusChrome = async () => {
    await mavatApi("/api/chrome/focus", { method: "POST" });
  };

  const active = ["recording", "connecting"].includes(recording.state);
  return (
    <div className="mx-auto max-w-7xl space-y-7">
      <AutomationContext />
      <PageHeader
        eyebrow="הקלטה ולימוד"
        title="הקלטת פעולות"
        description="צפה בדפדפן, הקלט פעולות ובדוק מיד מה נשמר — כולל צילום קטן לכל שלב. השלמת ערכים ועריכה מתקדמת נמצאות במסך שלבי העבודה."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/workflow">
                <Wrench className="size-4" />
                השלמה ועריכת שלבים
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setChromeBusy(true);
                void ensureChrome(true)
                  .catch((error) => toast.error((error as Error).message))
                  .finally(() => setChromeBusy(false));
              }}
              disabled={chromeBusy || active}
            >
              <Chrome className="size-4" />
              {chromeBusy ? "מתחבר ל-Chrome…" : "פתח Chrome של החשבון"}
            </Button>
            <Button onClick={() => record("start")} disabled={active || chromeBusy}>
              <Radio className="size-4" />
              התחל הקלטה
            </Button>
            <Button variant="outline" onClick={() => record("stop")} disabled={!active}>
              <Square className="size-4" />
              עצור
            </Button>
          </>
        }
      />
      {secureAuthMessage && (
        <Card className="border-amber-300 bg-amber-50/80" role="status">
          <CardContent className="flex items-start gap-3 py-4 text-right text-amber-950">
            <ShieldCheck className="mt-0.5 size-5 shrink-0" />
            <div>
              <p className="font-semibold">אימות ממשלתי מאובטח</p>
              <p className="text-sm">{secureAuthMessage}</p>
              <p className="mt-1 text-xs text-amber-800">אין צורך ללחוץ „המשך” בתוכנה.</p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card
        className={
          recording.state === "recording" ? "border-destructive/40 bg-destructive/[0.02]" : ""
        }
      >
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <span
            className={`size-3 rounded-full ${recording.state === "recording" ? "animate-pulse bg-destructive" : "bg-muted-foreground/40"}`}
          />
          <strong>{recording.message}</strong>
          <Badge
            className="me-auto"
            variant={recording.state === "recording" ? "destructive" : "secondary"}
          >
            {recording.state === "recording" ? "קולט Raw CDP ברקע" : "מוכן"}
          </Badge>
          <Badge variant={backgroundConnected ? "default" : "outline"}>
            <span
              className={`ms-1 size-2 rounded-full ${backgroundConnected ? "bg-emerald-400" : "bg-muted-foreground/40"}`}
            />
            {backgroundConnected ? "WebSocket מחובר" : "WebSocket מתחבר"}
          </Badge>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="flex gap-3 p-4">
            <MousePointer2 className="mt-1 size-5 text-accent" />
            <div>
              <strong className="text-sm">צופה Raw CDP ברקע</strong>
              <p className="text-xs text-muted-foreground">
                לחיצות, ניווטים, מילוי שדות ובחירות Dropdown נקלטים גם בלשוניות ובמסגרות חדשות.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex gap-3 p-4">
            <Camera className="mt-1 size-5 text-accent" />
            <div>
              <strong className="text-sm">ערכים וכספת סיסמאות</strong>
              <p className="text-xs text-muted-foreground">
                ערכים רגילים נשמרים בשלב. סיסמה נשמרת רק בכספת Windows ומקושרת לפרופיל, בלי להופיע
                בצילום, ב-workflow או בלוג.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex gap-3 p-4">
            <ListChecks className="mt-1 size-5 text-accent" />
            <div>
              <strong className="text-sm">בדיקה וניהול</strong>
              <p className="text-xs text-muted-foreground">
                בחר כמה שלבים, העתק, השהה, מחק או הרץ אותם יחד.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <LivePreview
        live={live}
        full={fullPreview}
        recordingMode={recording.state === "recording"}
        onFull={() => setFullPreview((value) => !value)}
        onToggle={() => togglePreview().catch((error) => toast.error(error.message))}
        onSelect={(id) => selectPreviewTab(id).catch((error) => toast.error(error.message))}
        onFocus={() => focusChrome().catch((error) => toast.error(error.message))}
        onStepSaved={loadWorkflow}
      />

      <RecordedStepsPanel
        steps={data.workflow.steps}
        profiles={data.profiles}
        onChanged={loadWorkflow}
      />
    </div>
  );
}
