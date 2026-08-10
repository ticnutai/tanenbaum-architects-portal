import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Chrome, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { mavatApi } from "@/lib/mavat-api";

type ChromeProfile = { directory: string; name: string; account: string; avatar: string; imported: boolean };
type ChromeImport = { state: string; message: string; current: number; total: number; warnings: string[] };
type ChromeProfilesData = { profiles: ChromeProfile[]; selected_directory: string; source_count: number; imported_count: number; import: ChromeImport };

export function ChromeProfiles() {
  const [data, setData] = useState<ChromeProfilesData | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => setData(await mavatApi<ChromeProfilesData>("/api/chrome/profiles"));

  useEffect(() => {
    load().catch((error) => toast.error(error.message));
    const timer = window.setInterval(() => load().catch(() => undefined), 1500);
    return () => window.clearInterval(timer);
  }, []);

  const importing = ["preparing", "copying"].includes(data?.import.state || "");
  const importProfile = async (directory: string) => {
    try {
      setBusy(true);
      const result = await mavatApi<{ message: string }>("/api/chrome/import", { method: "POST", body: JSON.stringify({ profiles: [directory] }) });
      toast.success(result.message);
      await load();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  };
  const select = async (directory: string) => {
    try {
      await mavatApi("/api/chrome/select", { method: "POST", body: JSON.stringify({ directory }) });
      await load(); toast.success("פרופיל Chrome נבחר להפעלות הבאות");
    } catch (error) { toast.error((error as Error).message); }
  };

  const progress = data?.import.total ? Math.round((data.import.current / data.import.total) * 100) : 0;
  return <Card className="border-primary/25">
    <CardHeader>
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground"><Chrome className="size-5" /></span>
        <div className="min-w-0 flex-1"><CardTitle className="font-display text-xl">פרופיל Chrome של האוטומציה</CardTitle><CardDescription className="mt-1">בחר וייבא פרופיל אחד בלבד, עם הסימניות, ההרחבות והחיבורים שלו.</CardDescription></div>
        <Badge variant="secondary">{data?.imported_count || 0} פרופיל מיובא</Badge>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      {importing && <div className="space-y-2 rounded-md border bg-muted/40 p-4"><div className="flex items-center gap-2 text-sm"><RefreshCw className="size-4 animate-spin" /><strong>{data?.import.message}</strong></div><Progress value={progress} /><p className="text-xs text-muted-foreground">{progress}% · אין לסגור את התוכנה עד לסיום הייבוא</p></div>}
      {data?.import.state === "completed" && <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"><CheckCircle2 className="size-4 text-emerald-600" />{data.import.message}</div>}
      {!!data?.import.warnings.length && <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm"><p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4 text-accent" />הייבוא הושלם עם הערות</p>{data.import.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-muted-foreground">{warning}</p>)}</div>}
      <div className="grid max-h-80 gap-2 overflow-y-auto pe-1 md:grid-cols-2">
        {data?.profiles.map((profile) => <div key={profile.directory} className={`flex items-center gap-3 rounded-md border p-3 text-right transition-colors ${data.selected_directory === profile.directory && profile.imported ? "border-primary bg-primary/5 ring-2 ring-primary/10" : "border-border"}`}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted font-semibold">{profile.name.slice(0, 1)}</span><span className="min-w-0 flex-1"><strong className="block truncate text-sm">{profile.name}</strong><span className="block truncate text-xs text-muted-foreground" dir="ltr">{profile.account || profile.directory}</span></span>{profile.imported ? <Button size="sm" variant={data.selected_directory === profile.directory ? "secondary" : "outline"} disabled={importing} onClick={() => select(profile.directory)}>{data.selected_directory === profile.directory ? "נבחר" : "בחר"}</Button> : <Button size="sm" variant="outline" disabled={busy || importing} onClick={() => importProfile(profile.directory)}><Download className="size-3.5" />ייבא רק אותו</Button>}
        </div>)}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">הייבוא אינו משנה את Chrome הרגיל. Chrome עשוי לבקש כניסה חד־פעמית מחדש בחלק מהחשבונות המוגנים.</p>
    </CardContent>
  </Card>;
}
