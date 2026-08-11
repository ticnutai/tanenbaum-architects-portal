import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Camera, ListChecks, MousePointer2, Radio, Square, Wrench } from "lucide-react";
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
  const [data, setData] = useState<WorkflowData>({ workflow: { name: "", steps: [] }, profiles: {} });
  const [recording, setRecording] = useState({
    state: "idle",
    message: "ההקלטה כבויה",
    transport: "raw-cdp-websocket",
    background: true,
  });
  const [live, setLive] = useState<LiveData | null>(null);
  const [fullPreview, setFullPreview] = useState(false);
  const [backgroundConnected, setBackgroundConnected] = useState(false);

  const loadWorkflow = async () => setData(await mavatApi<WorkflowData>("/api/workflow"));
  const loadRecording = async () => setRecording(await mavatApi("/api/recording/status"));
  const loadLive = async () => {
    try {
      setLive(await mavatApi<LiveData>("/api/chrome/live"));
    } catch {
      // Chrome and Python may briefly reconnect while the desktop app starts.
    }
  };
  const refresh = async () => Promise.all([loadWorkflow(), loadRecording(), loadLive()]);

  useEffect(() => {
    void refresh().catch((error) => toast.error(error.message));
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/events`);
    socket.onopen = () => setBackgroundConnected(true);
    socket.onclose = () => setBackgroundConnected(false);
    socket.onerror = () => setBackgroundConnected(false);
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type?: string };
        if (["connected", "step-recorded", "recording-status", "chrome-console"].includes(event.type || "")) {
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
  }, []);

  const record = async (action: "start" | "stop") => {
    const result = await mavatApi<{ message: string }>(`/api/recording/${action}`, { method: "POST" });
    toast(result.message);
    await refresh();
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
            <Button onClick={() => record("start")} disabled={active}>
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

      <Card className={recording.state === "recording" ? "border-destructive/40 bg-destructive/[0.02]" : ""}>
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <span className={`size-3 rounded-full ${recording.state === "recording" ? "animate-pulse bg-destructive" : "bg-muted-foreground/40"}`} />
          <strong>{recording.message}</strong>
          <Badge className="me-auto" variant={recording.state === "recording" ? "destructive" : "secondary"}>
            {recording.state === "recording" ? "קולט Raw CDP ברקע" : "מוכן"}
          </Badge>
          <Badge variant={backgroundConnected ? "default" : "outline"}>
            <span className={`ms-1 size-2 rounded-full ${backgroundConnected ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
            {backgroundConnected ? "WebSocket מחובר" : "WebSocket מתחבר"}
          </Badge>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="flex gap-3 p-4"><MousePointer2 className="mt-1 size-5 text-accent"/><div><strong className="text-sm">צופה Raw CDP ברקע</strong><p className="text-xs text-muted-foreground">לחיצות, מילוי שדות ובחירות Dropdown נשלחים מיד מה-Chrome החיצוני דרך WebSocket.</p></div></CardContent></Card>
        <Card><CardContent className="flex gap-3 p-4"><Camera className="mt-1 size-5 text-accent"/><div><strong className="text-sm">צילום לכל שלב</strong><p className="text-xs text-muted-foreground">ערכי סיסמה אינם מצולמים או נשמרים; לפעולות רגילות נשמרת תמונת אימות.</p></div></CardContent></Card>
        <Card><CardContent className="flex gap-3 p-4"><ListChecks className="mt-1 size-5 text-accent"/><div><strong className="text-sm">בדיקה וניהול</strong><p className="text-xs text-muted-foreground">בחר כמה שלבים, העתק, השהה, מחק או הרץ אותם יחד.</p></div></CardContent></Card>
      </div>

      <LivePreview
        live={live}
        full={fullPreview}
        onFull={() => setFullPreview((value) => !value)}
        onToggle={() => togglePreview().catch((error) => toast.error(error.message))}
        onSelect={(id) => selectPreviewTab(id).catch((error) => toast.error(error.message))}
        onFocus={() => focusChrome().catch((error) => toast.error(error.message))}
        onStepSaved={loadWorkflow}
      />

      <RecordedStepsPanel steps={data.workflow.steps} profiles={data.profiles} onChanged={loadWorkflow} />
    </div>
  );
}
