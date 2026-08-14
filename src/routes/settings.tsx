import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { mavatApi, type SettingsData } from "@/lib/mavat-api";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "הגדרות — טננבאום אדריכלות" }] }),
  component: SettingsPage,
});

type Provider = "auto" | "browseros" | "chrome";
type EngineDraft = AutomationEngineLifecycleSettings;

const cardClass = "rounded-xl border border-border bg-card p-6 shadow-sm";
const buttonClass = "inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass = "inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [provider, setProvider] = useState<Provider>("auto");
  const [providerSaved, setProviderSaved] = useState<Provider>("auto");
  const [engine, setEngine] = useState<EngineDraft>({ autoConnect: false, keepConnected: true, idleMinutes: 20 });
  const [engineSaved, setEngineSaved] = useState<EngineDraft>({ autoConnect: false, keepConnected: true, idleMinutes: 20 });
  const [engineStatus, setEngineStatus] = useState<AutomationEngineLifecycleStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [extensionPath, setExtensionPath] = useState("");

  const applySettings = (data: SettingsData) => {
    const selected = data.browser_provider || "auto";
    const lifecycle = {
      autoConnect: data.automation_engine?.auto_connect ?? false,
      keepConnected: data.automation_engine?.keep_connected ?? true,
      idleMinutes: data.automation_engine?.idle_minutes ?? 20,
    };
    setSettings(data);
    setProvider(selected);
    setProviderSaved(selected);
    setEngine(lifecycle);
    setEngineSaved(lifecycle);
  };

  const reload = async () => applySettings(await mavatApi<SettingsData>("/api/settings"));

  useEffect(() => {
    let active = true;
    mavatApi<SettingsData>("/api/settings")
      .then((data) => { if (active) applySettings(data); })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "טעינת ההגדרות נכשלה"); });
    return () => { active = false; };
  }, []);

  const run = async (name: string, action: () => Promise<void>, success: string) => {
    setBusy(name);
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "הפעולה נכשלה");
    } finally {
      setBusy("");
    }
  };

  const saveProvider = () => run("provider", async () => {
    await mavatApi("/api/settings/browser-provider", { method: "POST", body: JSON.stringify({ provider }) });
    await reload();
  }, "חיבור הדפדפן נשמר");

  const saveEngine = () => run("engine-save", async () => {
    await mavatApi("/api/settings/automation-engine", {
      method: "POST",
      body: JSON.stringify({ auto_connect: engine.autoConnect, keep_connected: engine.keepConnected, idle_minutes: engine.idleMinutes }),
    });
    const status = await window.mavatDesktop?.automationEngine.configure(engine);
    if (status) setEngineStatus(status);
    setEngineSaved(engine);
  }, "הגדרות מנוע האוטומציה נשמרו");

  const controlEngine = (action: "connect" | "disconnect") => run(`engine-${action}`, async () => {
    const desktop = window.mavatDesktop?.automationEngine;
    if (!desktop) throw new Error("השליטה במנוע זמינה באפליקציית Electron בלבד");
    setEngineStatus(action === "connect" ? await desktop.connect() : await desktop.disconnect());
  }, action === "connect" ? "מנוע האוטומציה מחובר" : "מנוע האוטומציה נותק");

  const refreshEngine = () => run("engine-status", async () => {
    const desktop = window.mavatDesktop?.automationEngine;
    if (!desktop) throw new Error("השליטה במנוע זמינה באפליקציית Electron בלבד");
    setEngineStatus(await desktop.status());
  }, "סטטוס המנוע עודכן");

  const createPairingCode = () => run("pair", async () => {
    await mavatApi("/api/extension/admin/pairing-code", { method: "POST" });
    await reload();
  }, "נוצר קוד חיבור חד־פעמי");

  const revokeExtensions = () => {
    if (!window.confirm("לבטל את כל חיבורי תוסף ההקלטה?")) return;
    void run("revoke", async () => {
      await mavatApi("/api/extension/admin/revoke", { method: "POST" });
      await reload();
    }, "חיבורי התוסף בוטלו");
  };

  const showExtensionFolder = () => run("folder", async () => {
    const extension = window.mavatDesktop?.extension;
    if (!extension) throw new Error("פתיחת התיקייה זמינה באפליקציית Electron בלבד");
    const knownPath = await extension.getPath();
    if (knownPath) setExtensionPath(knownPath);
    await extension.showFolder();
  }, "תיקיית התוסף נפתחה");

  const engineDirty = JSON.stringify(engine) !== JSON.stringify(engineSaved);
  const engineLabel = engineStatus?.state === "active" ? "פעיל כעת" : engineStatus?.processRunning ? "מחובר וממתין" : "מוכן לפי דרישה";
  const extensionLive = Boolean(settings?.extension_bridge.live_count);

  return (
    <div className="mx-auto max-w-3xl space-y-8" data-testid="settings-page">
      <header className="space-y-2 border-b border-border pb-6">
        <p className="text-sm font-medium tracking-[0.25em] text-accent">תצורה</p>
        <h1 className="font-display text-4xl font-bold">הגדרות</h1>
        <p className="text-muted-foreground">חיבורי הדפדפן, מנוע האוטומציה ופרטי המשרד.</p>
      </header>
      {message ? <p className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm" role="status">{message}</p> : null}

      <section className={cardClass}>
        <SectionTitle title="דפדפן האוטומציה" description="BrowserOS מועדף אוטומטית; Chrome הייעודי נשאר כגיבוי." />
        <StatusRow label={settings?.browser.display_name || "בודק חיבור..."} detail={`CDP ${settings?.browser.port || "—"}`} active={Boolean(settings?.browser.connected)} />
        <SettingSelect label="בחירת מנוע" value={provider} onChange={(value) => setProvider(value as Provider)} options={[['auto', 'אוטומטי — BrowserOS מועדף, Chrome גיבוי'], ['browseros', 'BrowserOS בלבד'], ['chrome', 'Google Chrome ייעודי בלבד']]} />
        <div className="mt-4 flex gap-2"><button className={buttonClass} disabled={busy !== "" || provider === providerSaved} onClick={() => void saveProvider()}>שמירת חיבור</button><button className={secondaryButtonClass} disabled={busy !== "" || provider === providerSaved} onClick={() => setProvider(providerSaved)}>ביטול</button></div>
      </section>

      <section className={cardClass}>
        <SectionTitle title="מנוע האוטומציה" description="Playwright עולה רק כשמתחילים פעולה או כשלוחצים על חיבור." />
        <StatusRow label={engineLabel} detail="אין בדיקת רקע חוזרת" active={Boolean(engineStatus?.processRunning)} />
        <div className="mt-5 space-y-3">
          <SettingSelect label="חיבור המנוע עם פתיחת האפליקציה" value={engine.autoConnect ? 'on' : 'off'} onChange={(value) => setEngine((current) => ({ ...current, autoConnect: value === 'on' }))} options={[['off', 'כבוי — מומלץ'], ['on', 'פעיל']]} />
          <SettingSelect label="השארת המנוע מחובר אחרי פעולה" value={engine.keepConnected ? 'on' : 'off'} onChange={(value) => setEngine((current) => ({ ...current, keepConnected: value === 'on' }))} options={[['on', 'פעיל'], ['off', 'כבוי']]} />
          <SettingSelect label="ניתוק לאחר חוסר פעילות" value={String(engine.idleMinutes)} onChange={(value) => setEngine((current) => ({ ...current, idleMinutes: Number(value) }))} options={[5, 10, 20, 30, 60, 120].map((minutes) => [String(minutes), `${minutes} דקות`])} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2"><button className={buttonClass} disabled={busy !== "" || !engineDirty} onClick={() => void saveEngine()}>שמירת הגדרות מנוע</button><button className={secondaryButtonClass} disabled={busy !== "" || !engineDirty} onClick={() => setEngine(engineSaved)}>ביטול</button><button className={secondaryButtonClass} disabled={busy !== ""} onClick={() => void refreshEngine()}>רענון סטטוס</button><button className={secondaryButtonClass} disabled={busy !== "" || engineStatus?.state === "active"} onClick={() => void controlEngine(engineStatus?.processRunning ? "disconnect" : "connect")}>{engineStatus?.processRunning ? "ניתוק עכשיו" : "חיבור עכשיו"}</button></div>
      </section>

      <section className={cardClass}>
        <SectionTitle title="סיידבר הקלטה ב־BrowserOS" description="תצוגה חיה של השלבים; מנוע Python/CDP נשאר המנוע היחיד." />
        <StatusRow label="תוסף מקליט מבא״ת" detail={extensionLive ? `${settings?.extension_bridge.live_count} סיידבר מחובר` : settings?.extension_bridge.paired_count ? "הרשאה שמורה; הסיידבר אינו פתוח" : "עדיין לא אושר תוסף"} active={extensionLive} />
        {settings?.extension_bridge.pairing_active && settings.extension_bridge.pairing_code ? <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-center dark:bg-amber-950/20"><p className="text-sm text-muted-foreground">הזן את הקוד בסיידבר של BrowserOS</p><p className="mt-2 font-mono text-3xl font-bold tracking-[0.35em]" dir="ltr">{settings.extension_bridge.pairing_code}</p></div> : null}
        <div className="mt-4 flex flex-wrap gap-2"><button className={buttonClass} disabled={busy !== ""} onClick={() => void createPairingCode()}>יצירת קוד חיבור</button><button className={secondaryButtonClass} disabled={busy !== "" || !window.mavatDesktop} onClick={() => void showExtensionFolder()}>פתיחת תיקיית התוסף</button><button className={secondaryButtonClass} disabled={busy !== "" || !settings?.extension_bridge.paired_count} onClick={revokeExtensions}>ביטול כל החיבורים</button></div>
        {extensionPath ? <p className="mt-4 break-all rounded-md bg-muted p-2 text-xs" dir="ltr">{extensionPath}</p> : null}
      </section>

      <section className={cardClass}>
        <SectionTitle title="פרטי משרד" description="ערכי ברירת המחדל הנוכחיים." />
        <dl className="divide-y rounded-md border"><OfficeValue label="שם המשרד" value="משרד טננבאום אדריכלות" /><OfficeValue label="כתובת מבא״ת" value="https://mavat.iplan.gov.il" /><OfficeValue label="תיקיית פלט" value="C:\\Tannenbaum\\runs" /></dl>
      </section>
    </div>
  );
}

function SectionTitle({ title, description }: { title: string; description: string }) { return <div className="mb-4"><h2 className="font-display text-xl font-bold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>; }
function StatusRow({ label, detail, active }: { label: string; detail: string; active: boolean }) { return <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground">{detail}</p></div><span className={`rounded-full px-3 py-1 text-xs ${active ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'}`}>{active ? "מחובר" : "מוכן"}</span></div>; }
function SettingSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<string[]> }) { return <label className="mt-4 block space-y-2 text-sm font-medium"><span>{label}</span><select className={selectClass} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>; }
function OfficeValue({ label, value }: { label: string; value: string }) { return <div className="flex flex-wrap justify-between gap-2 p-3"><dt className="font-medium">{label}</dt><dd className="text-muted-foreground" dir={value.startsWith('http') || value.includes('\\') ? 'ltr' : 'rtl'}>{value}</dd></div>; }
