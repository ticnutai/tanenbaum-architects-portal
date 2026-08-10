import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bot, Copy, ListOrdered, Plus, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mavatApi, type AutomationsData, type AutomationSummary } from "@/lib/mavat-api";

export const Route = createFileRoute("/automations")({ component: AutomationsPage });

function AutomationsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<AutomationsData>({ automations: [], active_id: "" });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceId, setSourceId] = useState("");

  const load = async () => setData(await mavatApi<AutomationsData>("/api/automations"));
  useEffect(() => { load().catch((error) => toast.error(error.message)); }, []);

  const create = async () => {
    try {
      const result = await mavatApi<{ automation: AutomationSummary }>("/api/automations", {
        method: "POST",
        body: JSON.stringify({ name, description, source_id: sourceId }),
      });
      await mavatApi(`/api/automations/${result.automation.id}/activate`, { method: "POST" });
      setCreating(false); setName(""); setDescription(""); setSourceId("");
      await load();
      toast.success("האוטומציה נוצרה ומוכנה להגדרה");
    } catch (error) { toast.error((error as Error).message); }
  };

  const activate = async (id: string) => {
    await mavatApi(`/api/automations/${id}/activate`, { method: "POST" });
    await load();
  };

  const openAutomation = async (id: string) => {
    try {
      await activate(id);
      await navigate({ to: "/automations/$automationId", params: { automationId: id } });
    } catch (error) {
      toast.error((error as Error).message || "לא ניתן לפתוח את האוטומציה");
    }
  };

  const remove = async (item: AutomationSummary) => {
    if (!confirm(`למחוק את „${item.name}” ואת כל השלבים שלה?`)) return;
    try { await mavatApi(`/api/automations/${item.id}`, { method: "DELETE" }); await load(); toast.success("האוטומציה נמחקה"); }
    catch (error) { toast.error((error as Error).message); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader eyebrow="מרכז האוטומציות" title="אוטומציות" description="כל אוטומציה מכילה כניסה לאתר, שלבי עבודה, מקור נתונים, הפעלה ויומן משלה."
        actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" />אוטומציה חדשה</Button>} />

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {data.automations.map((item) => (
          <Card key={item.id} className={`flex min-h-72 flex-col transition-all hover:-translate-y-0.5 hover:shadow-md ${item.active ? "border-primary/50 ring-2 ring-primary/10" : ""}`}>
            <CardHeader>
              <div className="flex items-start gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Bot className="size-5" /></span>
                <div className="min-w-0 flex-1"><CardTitle className="font-display text-xl">{item.name}</CardTitle><CardDescription className="mt-1 leading-6">{item.description}</CardDescription></div>
                {item.active && <Badge>נבחרה</Badge>}
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm"><ListOrdered className="size-4 text-accent" /><strong>{item.steps_count}</strong> שלבים מוגדרים</div>
              <div className="mt-auto flex gap-2">
                <Button className="flex-1" onClick={() => openAutomation(item.id)}><Settings2 className="size-4" />פתיחה והגדרה</Button>
                <Button variant="outline" size="icon" title="שכפול" onClick={() => { setSourceId(item.id); setName(`${item.name} — עותק`); setDescription(item.description); setCreating(true); }}><Copy className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="מחיקה" disabled={item.active} onClick={() => remove(item)}><Trash2 className="size-4" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent dir="rtl"><DialogHeader><DialogTitle className="font-display text-2xl">אוטומציה חדשה</DialogTitle><DialogDescription>אפשר להתחיל מתהליך ריק או לשכפל אוטומציה קיימת ולהתאים אותה.</DialogDescription></DialogHeader>
          <div className="space-y-4"><Field label="שם האוטומציה"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: הגשת תכנית חדשה" /></Field><Field label="תיאור"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="מה התהליך מבצע" /></Field><Field label="בסיס לשלבים"><select className="h-10 w-full rounded-md border bg-background px-3" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">התחלה מתהליך ריק</option>{data.automations.map((item) => <option key={item.id} value={item.id}>שכפול: {item.name}</option>)}</select></Field></div>
          <DialogFooter><Button variant="outline" onClick={() => setCreating(false)}>ביטול</Button><Button onClick={create}><Plus className="size-4" />יצירת אוטומציה</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-2"><Label>{label}</Label>{children}</div>; }
