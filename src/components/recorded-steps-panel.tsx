import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCheck,
  Copy,
  ExternalLink,
  ImageIcon,
  Pause,
  Play,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ensureMavatChromeReady,
  mavatApi,
  type ProfileStatus,
  type WorkflowStep,
} from "@/lib/mavat-api";

function stepDetail(step: WorkflowStep) {
  if (step.type === "fill_secret") return "סיסמה מאובטחת — הערך אינו מוצג";
  return step.value || step.target || step.page_url || "ללא פרטים נוספים";
}

export function RecordedStepsPanel({
  steps,
  profiles,
  onChanged,
}: {
  steps: WorkflowStep[];
  profiles: Record<string, ProfileStatus>;
  onChanged: () => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [photo, setPhoto] = useState<{ index: number; step: WorkflowStep } | null>(null);
  const allSelected = steps.length > 0 && selected.size === steps.length;
  const selectedIndices = useMemo(() => [...selected].sort((a, b) => a - b), [selected]);

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((index) => index < steps.length)));
  }, [steps.length]);

  const toggle = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const bulk = async (action: "delete" | "duplicate" | "pause" | "resume") => {
    if (!selected.size) return;
    if (action === "delete" && !confirm(`למחוק ${selected.size} שלבים?`)) return;
    await mavatApi("/api/steps/bulk", {
      method: "POST",
      body: JSON.stringify({ indices: selectedIndices, action }),
    });
    setSelected(new Set());
    await onChanged();
    toast.success(
      action === "delete"
        ? "השלבים נמחקו"
        : action === "duplicate"
          ? "נוצר עותק של השלבים"
          : "מצב השלבים עודכן",
    );
  };
  const run = async () => {
    const profileId = Object.keys(profiles)[0];
    if (!profileId) {
      toast.error("יש להגדיר פרופיל כניסה לפני הרצה");
      return;
    }
    if (!confirm(`להריץ כעת ${selected.size} שלבים ב-Chrome?`)) return;
    await ensureMavatChromeReady();
    await mavatApi("/api/run/start", {
      method: "POST",
      body: JSON.stringify({ profile_id: profileId, dry_run: false, step_indices: selectedIndices }),
    });
    toast.success("הרצת השלבים שנבחרו התחילה");
  };

  return (
    <Card>
      <CardHeader className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="font-display text-2xl">השלבים שנקלטו</CardTitle>
            <CardDescription>
              כל פעולה מופיעה מיד עם היעד, שיטת הזיהוי ותמונת המסך בזמן ההקלטה.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="px-3 py-2">
              {steps.length} שלבים
            </Badge>
            <Button variant="outline" asChild>
              <Link to="/workflow">
                <Plus className="size-4" />
                הוספה והשלמה ידנית
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(steps.map((_, index) => index)))
            }
          >
            <CheckCheck className="size-4" />
            {allSelected ? "בטל בחירת הכול" : "בחר הכול"}
          </Button>
          <Badge variant={selected.size ? "default" : "outline"}>{selected.size} נבחרו</Badge>
          <Button size="sm" disabled={!selected.size} onClick={run}>
            <Play className="size-4" /> הרץ
          </Button>
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => bulk("duplicate")}>
            <Copy className="size-4" /> העתק
          </Button>
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => bulk("pause")}>
            <Pause className="size-4" /> השהה
          </Button>
          <Button size="sm" variant="outline" disabled={!selected.size} onClick={() => bulk("resume")}>
            <Play className="size-4" /> הפעל
          </Button>
          <Button size="sm" variant="destructive" disabled={!selected.size} onClick={() => bulk("delete")}>
            <Trash2 className="size-4" /> מחק
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {steps.map((step, index) => (
            <article
              key={`${index}-${step.name}-${step.recorded_at || ""}`}
              className={`grid gap-4 rounded-lg border p-4 transition-colors lg:grid-cols-[auto_9rem_1fr_auto] ${
                selected.has(index) ? "border-primary bg-primary/5 ring-2 ring-primary/10" : "bg-card"
              } ${step.enabled === false ? "opacity-55" : ""}`}
            >
              <label className="flex cursor-pointer items-start gap-3 pt-1">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={selected.has(index)}
                  onChange={() => toggle(index)}
                />
                <span className="font-mono text-sm text-muted-foreground">{index + 1}</span>
              </label>
              {step.screenshot ? (
                <button
                  className="group relative aspect-video overflow-hidden rounded-md border bg-slate-950"
                  onClick={() => setPhoto({ index, step })}
                  title="פתיחת צילום גדול"
                >
                  <img
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    src={`/api/steps/${index}/screenshot?v=${encodeURIComponent(step.recorded_at || String(index))}`}
                    alt={`צילום של שלב ${index + 1}`}
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1 text-xs text-white">
                    לחץ להגדלה
                  </span>
                </button>
              ) : (
                <div className="grid aspect-video place-items-center rounded-md border border-dashed bg-muted/30 text-muted-foreground">
                  <ImageIcon className="size-6 opacity-50" />
                  <span className="text-xs">אין צילום</span>
                </div>
              )}
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{step.name || `שלב ${index + 1}`}</strong>
                  <Badge variant={step.type === "manual" ? "destructive" : "secondary"} className="font-mono">
                    {step.type}
                  </Badge>
                  {step.enabled === false && <Badge variant="outline">מושהה</Badge>}
                </div>
                <p className="truncate text-sm text-muted-foreground">{stepDetail(step)}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>זיהוי: {step.locator?.strategy || "ידני"}</span>
                  {step.confidence !== undefined && <span>אמינות: {step.confidence}%</span>}
                  {step.recorded_at && (
                    <span>{new Date(step.recorded_at).toLocaleString("he-IL")}</span>
                  )}
                </div>
                {step.page_url && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
                    {step.page_url}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 lg:flex-col lg:items-stretch">
                <Button variant="outline" size="sm" asChild>
                  <Link to="/workflow">
                    <SquarePen className="size-4" /> עריכה
                  </Link>
                </Button>
                {step.page_url && (
                  <Button variant="ghost" size="sm" asChild>
                    <a href={step.page_url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" /> הדף
                    </a>
                  </Button>
                )}
              </div>
            </article>
          ))}
          {!steps.length && (
            <div className="grid min-h-48 place-items-center rounded-lg border border-dashed text-center text-muted-foreground">
              <div>
                <ImageIcon className="mx-auto mb-3 size-9 opacity-40" />
                <p className="font-semibold">עדיין לא נקלטו פעולות</p>
                <p className="text-sm">הפעל הקלטה ובצע פעולה בדפדפן החי.</p>
              </div>
            </div>
          )}
        </div>
      </CardContent>
      {photo && (
        <Dialog open onOpenChange={(open) => !open && setPhoto(null)}>
          <DialogContent className="max-w-5xl" dir="rtl">
            <DialogHeader>
              <DialogTitle>צילום שלב {photo.index + 1}: {photo.step.name}</DialogTitle>
              <DialogDescription>{photo.step.page_url || "צילום בזמן ההקלטה"}</DialogDescription>
            </DialogHeader>
            <img
              className="max-h-[72vh] w-full rounded-md border bg-slate-950 object-contain"
              src={`/api/steps/${photo.index}/screenshot?v=${encodeURIComponent(photo.step.recorded_at || String(photo.index))}`}
              alt={`צילום מוגדל של שלב ${photo.index + 1}`}
            />
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
