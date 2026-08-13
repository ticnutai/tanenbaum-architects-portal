import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { mavatApi, type SettingsData } from "@/lib/mavat-api";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "הגדרות — טננבאום אדריכלות" },
      {
        name: "description",
        content: "הגדרות המשרד והמערכת: פרטי משרד, כתובת מבא״ת, תיקיית פלט והתנהגות ברירת מחדל.",
      },
      { property: "og:title", content: "הגדרות — טננבאום אדריכלות" },
      { property: "og:description", content: "הגדרות המשרד ותצורת המערכת." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [provider, setProvider] = useState<"auto" | "browseros" | "chrome">("auto");
  const [saving, setSaving] = useState(false);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const [extensionPath, setExtensionPath] = useState("");
  const extensionLive = Boolean(settings?.extension_bridge.live_count);
  const load = useCallback(async () => {
    const data = await mavatApi<SettingsData>("/api/settings");
    setSettings(data);
    setProvider(data.browser_provider || "auto");
  }, []);
  useEffect(() => {
    void load().catch((error) => toast.error(error.message));
    if (window.mavatDesktop?.extension) {
      void window.mavatDesktop.extension.getPath().then(setExtensionPath);
    }
  }, [load]);
  const saveProvider = async () => {
    setSaving(true);
    try {
      await mavatApi("/api/settings/browser-provider", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      await load();
      toast.success("חיבור הדפדפן נשמר");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "שמירת החיבור נכשלה");
    } finally {
      setSaving(false);
    }
  };
  const createPairingCode = async () => {
    setExtensionBusy(true);
    try {
      await mavatApi("/api/extension/admin/pairing-code", { method: "POST" });
      await load();
      toast.success("נוצר קוד חיבור חד־פעמי לעשר דקות");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "יצירת הקוד נכשלה");
    } finally {
      setExtensionBusy(false);
    }
  };
  const revokeExtensions = async () => {
    if (!window.confirm("לבטל את כל חיבורי תוסף ההקלטה?")) return;
    setExtensionBusy(true);
    try {
      await mavatApi("/api/extension/admin/revoke", { method: "POST" });
      await load();
      toast.success("חיבורי התוסף בוטלו");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ביטול החיבורים נכשל");
    } finally {
      setExtensionBusy(false);
    }
  };
  const showExtensionFolder = async () => {
    try {
      const path = await window.mavatDesktop?.extension.showFolder();
      if (path) setExtensionPath(path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "פתיחת תיקיית התוסף נכשלה");
    }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader eyebrow="תצורה" title="הגדרות" description="פרטי המשרד והתנהגות ברירת המחדל." />
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-lg">דפדפן האוטומציה</CardTitle>
          <CardDescription>
            BrowserOS נבחר אוטומטית דרך כתובת ה־MCP שמוצגת במסך Connected agents ודרך CDP;
            Chrome הייעודי נשאר כגיבוי.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <p className="font-medium">{settings?.browser.display_name || "בודק חיבור..."}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">
                CDP {settings?.browser.port || "—"}
                {settings?.browser.mcp_url ? ` · ${settings.browser.mcp_url}` : ""}
              </p>
            </div>
            <Badge variant={settings?.browser.connected ? "default" : "destructive"}>
              {settings?.browser.connected ? "מחובר" : "מנותק"}
            </Badge>
          </div>
          <div className="space-y-2">
            <Label htmlFor="browser-provider">בחירת מנוע</Label>
            <select
              id="browser-provider"
              className="h-10 w-full rounded-md border bg-background px-3"
              value={provider}
              onChange={(event) => setProvider(event.target.value as typeof provider)}
            >
              <option value="auto">אוטומטי — BrowserOS מועדף, Chrome גיבוי</option>
              <option value="browseros">BrowserOS בלבד</option>
              <option value="chrome">Google Chrome ייעודי בלבד</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={saving || provider === settings?.browser_provider}
              onClick={saveProvider}
            >
              {saving ? "שומר..." : "שמירת חיבור"}
            </Button>
            <Button
              variant="outline"
              disabled={saving || provider === settings?.browser_provider}
              onClick={() => setProvider(settings?.browser_provider || "auto")}
            >
              ביטול
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-lg">סיידבר הקלטה ב־BrowserOS</CardTitle>
          <CardDescription>
            תצוגה חיה של השלבים בזמן העבודה בדפדפן. ההקלטה עצמה ממשיכה להתבצע במנוע Python/CDP היחיד
            — הסיידבר אינו יוצר מנוע נוסף, וחיבור ה־MCP אינו מוחלף על ידו.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <p className="font-medium">תוסף מקליט מבא״ת</p>
              <p className="text-xs text-muted-foreground">
                {extensionLive
                  ? `${settings?.extension_bridge.live_count} סיידבר מחובר כעת`
                  : settings?.extension_bridge.paired_count
                    ? `${settings.extension_bridge.paired_count} הרשאה שמורה; הסיידבר אינו פתוח כעת`
                    : "עדיין לא אושר תוסף"}
              </p>
            </div>
            <Badge variant={extensionLive ? "default" : "secondary"}>
              {extensionLive
                ? "מחובר עכשיו"
                : settings?.extension_bridge.paired_count
                  ? "מורשה, לא פעיל"
                  : "ממתין לאישור"}
            </Badge>
          </div>
          {settings?.extension_bridge.pairing_active && settings.extension_bridge.pairing_code ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-center dark:bg-amber-950/20">
              <p className="text-sm text-muted-foreground">הזן את הקוד בסיידבר של BrowserOS</p>
              <p className="mt-2 font-mono text-3xl font-bold tracking-[0.35em]" dir="ltr">
                {settings.extension_bridge.pairing_code}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                הקוד חד־פעמי ותקף עד {settings.extension_bridge.pairing_expires_at || "עשר דקות"}
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={createPairingCode} disabled={extensionBusy}>
              {extensionBusy ? "מבצע..." : "יצירת קוד חיבור"}
            </Button>
            {window.mavatDesktop?.extension ? (
              <Button variant="outline" onClick={showExtensionFolder}>
                פתיחת תיקיית התוסף
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={revokeExtensions}
              disabled={extensionBusy || !settings?.extension_bridge.paired_count}
            >
              ביטול כל החיבורים
            </Button>
          </div>
          {extensionPath ? (
            <p
              className="break-all rounded-md bg-muted p-2 text-xs text-muted-foreground"
              dir="ltr"
            >
              {extensionPath}
            </p>
          ) : null}
          <ol className="list-decimal space-y-1 pe-5 text-sm text-muted-foreground">
            <li>פתח ב־BrowserOS את מסך התוספים והפעל מצב מפתח.</li>
            <li>בחר „טעינת תוסף שלא נארז” ובחר את התיקייה שמוצגת כאן.</li>
            <li>לחץ פעם אחת על סמל התוסף, הזן את הקוד, והסיידבר יישאר מחובר.</li>
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-lg">פרטי משרד</CardTitle>
          <CardDescription>מוצגים בכותרות ובדוחות</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="office">שם המשרד</Label>
            <Input id="office" defaultValue="משרד טננבאום אדריכלות" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mavat">כתובת מבא״ת</Label>
            <Input id="mavat" defaultValue="https://mavat.iplan.gov.il" dir="ltr" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="out">תיקיית פלט</Label>
            <Input id="out" defaultValue="C:\\Tannenbaum\\runs" dir="ltr" />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">התחל תמיד במצב בדיקה</p>
              <p className="text-xs text-muted-foreground">מומלץ להשאיר פעיל</p>
            </div>
            <Switch defaultChecked />
          </div>
          <Button>שמירת הגדרות</Button>
        </CardContent>
      </Card>
    </div>
  );
}
