import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bot, Chrome, Columns2, FileSpreadsheet, KeyRound, Link2, ListOrdered, Maximize2, Play, PlayCircle, Radio, ScrollText, Square, Unlink2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mavatApi, type AutomationDetail, type AutomationsData, type AutomationSummary } from "@/lib/mavat-api";

export const Route = createFileRoute("/automations_/$automationId")({
  component: AutomationWorkspace,
});

const sections = [
  {
    order: 1,
    title: "כניסה לאתר",
    description: "פרופיל Chrome, שם משתמש וסיסמה מאובטחת",
    icon: KeyRound,
    to: "/profiles" as const,
    action: "הגדרת כניסה",
  },
  {
    order: 2,
    title: "הקלטת פעולות",
    description: "דפדפן חי, הקלטת פעולות וצילום של כל שלב",
    icon: Radio,
    to: "/recorder" as const,
    action: "פתיחת המקליט",
  },
  {
    order: 3,
    title: "שלבי עבודה",
    description: "השלמה ידנית, עריכה וסידור של הפעולות באתר",
    icon: ListOrdered,
    to: "/workflow" as const,
    action: "עריכת השלבים",
  },
  {
    order: 4,
    title: "מקור נתונים",
    description: "בחירת Excel, CSV או Word והתאמת נתוני הלקוחות",
    icon: FileSpreadsheet,
    to: "/clients" as const,
    action: "בחירת נתונים",
  },
  {
    order: 5,
    title: "הפעלה",
    description: "בדיקה או הרצה אמיתית, עצירה והמשך",
    icon: PlayCircle,
    to: "/run" as const,
    action: "מעבר להפעלה",
  },
  {
    order: 6,
    title: "יומן ריצה",
    description: "תוצאות, שגיאות, צילומי מסך וקונסול",
    icon: ScrollText,
    to: "/logs" as const,
    action: "פתיחת היומן",
  },
];

function AutomationWorkspace() {
  const { automationId } = Route.useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<AutomationSummary | null>(null);
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [engine, setEngine] = useState<AutomationEngineStatus | null>(null);
  const [engineBusy, setEngineBusy] = useState("");
  const [windowsLinked, setWindowsLinked] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        await mavatApi(`/api/automations/${automationId}/activate`, { method: "POST" });
        const data = await mavatApi<AutomationsData>("/api/automations");
        const automation = data.automations.find((candidate) => candidate.id === automationId);
        if (!automation) throw new Error("האוטומציה לא נמצאה");
        setItem(automation);
        setDetail(await mavatApi<AutomationDetail>(`/api/automations/${automationId}`));
      } catch (error) {
        toast.error((error as Error).message || "לא ניתן לפתוח את האוטומציה");
        await navigate({ to: "/automations" });
      }
    };
    void load();
  }, [automationId, navigate]);

  useEffect(() => {
    const desktop = window.mavatDesktop?.automationEngine;
    if (!desktop) return;
    desktop.command<AutomationEngineStatus>("status").then(setEngine).catch(() => undefined);
    return desktop.onEvent((message) => {
      if (message.status) setEngine(message.status);
      if (message.type === "step-failed") toast.error(`השלב נכשל: ${String(message["error"] || "שגיאה לא ידועה")}`);
      if (message.type === "run-completed") toast.success("האוטומציה הסתיימה בהצלחה");
      if (message.type === "manual-required") toast.info(String(message["message"] || "נדרשת פעולה ידנית בדפדפן"));
    });
  }, []);

  useEffect(() => {
    window.mavatDesktop?.layout.getLinked().then(setWindowsLinked).catch(() => undefined);
  }, []);

  const missing = useMemo(
    () => (detail?.input_schema || []).filter((field) => field.required && !values[field.key]?.trim()),
    [detail, values],
  );

  const engineCommand = async (command: "prepare-profile" | "open-browser" | "run" | "stop") => {
    const desktop = window.mavatDesktop?.automationEngine;
    if (!desktop) {
      toast.error("מנוע Playwright המקצועי זמין ביישום Electron");
      return;
    }
    if (command === "run" && missing.length) {
      toast.error(`חסרים שדות חובה: ${missing.map((field) => field.label).join(", ")}`);
      return;
    }
    setEngineBusy(command);
    try {
      const result = await desktop.command<AutomationEngineStatus>(command, command === "run" ? {
        workflow: detail?.workflow,
        records: [values],
        startUrl: "https://www.gov.il/he/service/mvat",
      } : { startUrl: "https://www.gov.il/he/service/mvat" });
      if (command !== "run") setEngine(result);
      toast.success(command === "prepare-profile"
        ? "Chrome רגיל נפתח. התחבר לחשבון, סגור אותו ואז פתח את דפדפן האוטומציה"
        : command === "open-browser" ? "דפדפן האוטומציה נפתח"
          : command === "run" ? "ההרצה התחילה" : "נשלחה בקשת עצירה");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setEngineBusy("");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="סביבת אוטומציה"
        title={item?.name || "טוען אוטומציה…"}
        description={item?.description || "הגדר את התהליך לפי הסדר, ולאחר מכן בצע הרצת בדיקה."}
      />
      <Card className="border-primary/25 bg-primary/5">
        <CardContent className="flex flex-wrap items-center gap-4 py-5">
          <span className="flex size-12 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-6" />
          </span>
          <div className="flex-1">
            <p className="font-semibold">האוטומציה הזאת פעילה כעת במנוע Python</p>
            <p className="text-sm text-muted-foreground">
              כל שינוי בשלבים וכל הרצה יתבצעו עבורה בלבד.
            </p>
          </div>
          <Badge variant="secondary">{item?.steps_count ?? 0} שלבים</Badge>
        </CardContent>
      </Card>
      <Card className="overflow-hidden border-accent/35">
        <CardHeader className="border-b bg-accent/5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <CardTitle className="font-display text-2xl">הזנה והפעלה מהירה</CardTitle>
              <CardDescription>מלא את נתוני התוכנית והפעל את האוטומציה שנבחרה בדפדפן ייעודי.</CardDescription>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <i className={`size-2.5 rounded-full ${engine?.browserOpen ? "bg-emerald-500" : "bg-slate-300"}`} />
              {engine?.browserOpen ? "Google Chrome ייעודי מחובר" : "הדפדפן טרם נפתח"}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(detail?.input_schema || []).map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={`automation-field-${field.key}`}>
                  {field.label}{field.required && <span className="me-1 text-destructive">*</span>}
                </Label>
                {field.type === "select" ? (
                  <select id={`automation-field-${field.key}`} className="h-10 w-full rounded-md border bg-background px-3" value={values[field.key] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}>
                    <option value="">בחירה…</option>
                    {(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <>
                    <Input id={`automation-field-${field.key}`} list={field.type === "autocomplete" ? `automation-options-${field.key}` : undefined} type={field.type === "date" ? "date" : field.type === "number" || field.type === "decimal" ? "number" : "text"} step={field.type === "decimal" ? "any" : undefined} value={values[field.key] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.type === "autocomplete" ? `חפש או בחר ${field.label}` : `הזן ${field.label}`} />
                    {field.type === "autocomplete" && <datalist id={`automation-options-${field.key}`}>{(field.options || []).map((option) => <option key={option} value={option} />)}</datalist>}
                  </>
                )}
                <p className="font-mono text-[10px] text-muted-foreground" dir="ltr">{`{${field.key}}`}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 border-t pt-5">
            <Button variant="outline" onClick={() => engineCommand("prepare-profile")} disabled={Boolean(engineBusy) || engine?.profilePreparing}>
              <KeyRound className="size-4" />הכנת כניסה ראשונית ל-Google
            </Button>
            <Button variant="outline" onClick={() => engineCommand("open-browser")} disabled={Boolean(engineBusy)}>
              <Chrome className="size-4" />פתח דפדפן ייעודי
            </Button>
            <Button onClick={() => engineCommand("run")} disabled={Boolean(engineBusy) || engine?.running || !detail}>
              <Play className="size-4" />הפעל אוטומציה
            </Button>
            <Button variant="destructive" onClick={() => engineCommand("stop")} disabled={!engine?.running || Boolean(engineBusy)}>
              <Square className="size-4" />עצור
            </Button>
            {engine?.browserOpen && <Button variant="outline" onClick={async () => {
              try { await window.mavatDesktop?.layout.split(engine.profileDir); toast.success("החלונות הוצמדו מחדש"); }
              catch (error) { toast.error((error as Error).message); }
            }}><Columns2 className="size-4" />הצמד חלונות</Button>}
            <Button variant={windowsLinked ? "default" : "outline"} onClick={async () => {
              try {
                const enabled = await window.mavatDesktop?.layout.setLinked(!windowsLinked);
                setWindowsLinked(Boolean(enabled));
                toast.success(enabled ? "החלונות מקושרים: מזעור ושחזור יתבצעו יחד" : "קישור החלונות בוטל");
              } catch (error) { toast.error((error as Error).message); }
            }}>
              {windowsLinked ? <Link2 className="size-4" /> : <Unlink2 className="size-4" />}
              {windowsLinked ? "חלונות מקושרים" : "קישור חלונות"}
            </Button>
            <Button variant="ghost" onClick={() => window.mavatDesktop?.layout.maximize()}>
              <Maximize2 className="size-4" />מסך מלא
            </Button>
            <span className="self-center text-xs text-muted-foreground">{detail?.workflow.steps.length || 0} שלבים · פרופיל מבודד וקבוע</span>
          </div>
        </CardContent>
      </Card>
      <div className="relative grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {sections.map((section) => (
          <Card key={section.order} className="group flex min-h-60 flex-col">
            <CardHeader>
              <div className="mb-3 flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-md bg-muted text-primary group-hover:bg-primary group-hover:text-primary-foreground">
                  <section.icon className="size-5" />
                </span>
                <span className="font-display text-3xl font-bold text-muted-foreground/30">
                  {section.order}
                </span>
              </div>
              <CardTitle className="font-display text-xl">{section.title}</CardTitle>
              <CardDescription className="leading-6">{section.description}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto">
              <Button variant="outline" className="w-full" asChild>
                <Link to={section.to}>{section.action}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="rounded-md border border-accent/30 bg-accent/5 p-4 text-sm">
        <strong>סדר עבודה מומלץ:</strong> הגדר כניסה → הקלט או ערוך את השלבים → בחר קובץ נתונים →
        בצע בדיקה → עבור להרצה אמיתית.
      </div>
    </div>
  );
}
