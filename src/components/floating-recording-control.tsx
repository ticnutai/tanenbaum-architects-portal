import { LoaderCircle, Radio, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ensureMavatChromeReady, mavatApi } from "@/lib/mavat-api";

type RecordingStatus = {
  state: string;
  message: string;
  transport?: string;
  background?: boolean;
};

const IDLE_STATUS: RecordingStatus = {
  state: "idle",
  message: "ההקלטה כבויה",
};

export function FloatingRecordingControl() {
  const [status, setStatus] = useState<RecordingStatus>(IDLE_STATUS);
  const [busy, setBusy] = useState(false);
  const [reachable, setReachable] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await mavatApi<RecordingStatus>("/api/recording/status");
      setStatus(next);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const active = status.state === "recording" || status.state === "connecting";
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (active) {
        const result = await mavatApi<{ message: string }>("/api/recording/stop", {
          method: "POST",
        });
        toast.success(result.message || "ההקלטה נעצרה");
      } else {
        setStatus({ state: "connecting", message: "מתחבר לדפדפן…" });
        await ensureMavatChromeReady();
        const result = await mavatApi<{ message: string }>("/api/recording/start", {
          method: "POST",
        });
        toast.success(result.message || "ההקלטה הופעלה");
      }
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`פעולת ההקלטה נכשלה: ${message}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const label = busy ? "מבצע פעולה…" : active ? "עצור הקלטה" : "התחל הקלטה";

  return (
    <div
      className="fixed bottom-16 left-3 z-40 flex items-center gap-2 sm:bottom-3 sm:left-24"
      dir="rtl"
      data-testid="floating-recording-control"
    >
      <div
        className={`hidden rounded-lg border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur md:block ${
          active ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground"
        }`}
        role="status"
        aria-live="polite"
      >
        <span className="flex items-center gap-2 font-medium">
          <i
            className={`size-2 rounded-full ${
              active
                ? "animate-pulse bg-destructive"
                : reachable
                  ? "bg-emerald-500"
                  : "bg-muted-foreground/40"
            }`}
          />
          {busy ? "מבצע…" : active ? "מקליט עכשיו" : reachable ? "מוכן להקלטה" : "מנוע לא מחובר"}
        </span>
      </div>
      <Button
        type="button"
        size="lg"
        variant={active ? "destructive" : "default"}
        className={`h-12 rounded-full px-5 shadow-xl transition-transform hover:scale-[1.02] ${
          active ? "ring-4 ring-destructive/15" : "ring-4 ring-primary/10"
        }`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={label}
        title={`${label} — ${status.message}`}
      >
        {busy ? (
          <LoaderCircle className="size-5 animate-spin" />
        ) : active ? (
          <Square className="size-4 fill-current" />
        ) : (
          <Radio className="size-5" />
        )}
        <span>{label}</span>
      </Button>
    </div>
  );
}
