import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ClipboardCopy, FileDown, RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { AutomationContext } from "@/components/automation-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { copyMavatText, mavatApi, type LogsData } from "@/lib/mavat-api";
import { openSystemConsole } from "@/components/system-console-dock";

export const Route = createFileRoute("/logs")({ component: LogsPage });
const labels:Record<string,string>={error:"שגיאה",success:"הושלם",manual:"נעצר ידנית",recorded:"נקלט שלב",info:"מידע"};
function LogsPage(){
  const [data,setData]=useState<LogsData>({events:[],summary:{total:0,errors:0,success:0,manual:0}});const [filter,setFilter]=useState("all");const [query,setQuery]=useState("");
  const load=async()=>setData(await mavatApi<LogsData>("/api/logs?limit=800"));useEffect(()=>{load();const timer=setInterval(load,5000);return()=>clearInterval(timer)},[]);
  const events=useMemo(()=>data.events.filter(e=>(filter==="all"||e.status===filter)&&e.message.toLowerCase().includes(query.toLowerCase())),[data,filter,query]);const errors=data.events.filter(e=>e.status==="error");const report=["דוח שגיאות מבא״ת",`נוצר: ${new Date().toLocaleString("he-IL")}`,"",...(errors.length?errors.map(e=>`[${e.timestamp}] ${e.message}`):["לא נמצאו שגיאות."])].join("\n");
  const copy=async(text:string,message:string)=>{await copyMavatText(text);toast.success(message)};
  return <div className="mx-auto max-w-6xl space-y-8"><AutomationContext/><PageHeader eyebrow="תיעוד ובקרה" title="יומן ריצה" description="כל פעולה, עצירה ושגיאה נשמרת ביומן המקומי עם חותמת זמן." actions={<><Button variant="outline" onClick={load}><RefreshCw className="size-4"/>רענן</Button><Button variant="outline" onClick={()=>copy(report,"דוח השגיאות הועתק")}><ClipboardCopy className="size-4"/>דוח שגיאות</Button><Button onClick={openSystemConsole}><Terminal className="size-4"/>פתח קונסול</Button></>}/>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Stat label="כל האירועים" value={data.summary.total}/><Stat label="הושלמו" value={data.summary.success} tone="border-emerald-500"/><Stat label="שגיאות" value={data.summary.errors} tone="border-destructive"/><Stat label="עצירות ידניות" value={data.summary.manual} tone="border-accent"/></div>
    {errors.length>0&&<Card className="border-r-4 border-r-destructive"><CardContent className="flex items-center justify-between gap-4 py-5"><div className="flex gap-3"><AlertTriangle className="mt-1 size-5 text-destructive"/><div><h2 className="font-display text-xl font-bold">נמצאו {errors.length} שגיאות ביומן</h2><p className="text-sm text-muted-foreground">{errors[0]?.message}</p></div></div><Button variant="destructive" onClick={()=>copy(report,"דוח השגיאות הועתק")}><ClipboardCopy className="size-4"/>העתקת הדוח</Button></CardContent></Card>}
    <Card><CardHeader><CardTitle className="font-display text-2xl">אירועי המערכת</CardTitle><div className="flex flex-wrap gap-2 pt-3"><Input className="min-w-64 flex-1" value={query} onChange={e=>setQuery(e.target.value)} placeholder="חיפוש ביומן..."/><select className="rounded-md border bg-background px-3 text-sm" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">כל האירועים</option><option value="error">שגיאות</option><option value="success">הצלחות</option><option value="manual">עצירות ידניות</option><option value="recorded">פעולות שנקלטו</option></select><Button variant="outline" asChild><a href="/api/logs/export.csv" download><FileDown className="size-4"/>יצוא CSV</a></Button></div></CardHeader><CardContent className="divide-y divide-border">{events.map(e=><div key={e.id} className="flex items-center justify-between gap-4 py-4"><div><p className="font-medium">{e.message}</p><p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">{e.timestamp||"ללא חותמת זמן"}</p></div><Badge variant={e.status==="error"?"destructive":"secondary"}>{labels[e.status]||"מידע"}</Badge></div>)}{!events.length&&<p className="py-20 text-center text-muted-foreground">אין אירועים להצגה</p>}</CardContent></Card>
  </div>;
}
function Stat({label,value,tone="border-primary"}:{label:string;value:number;tone?:string}){return <Card className={`border-t-4 ${tone}`}><CardContent className="pt-5"><p className="text-sm text-muted-foreground">{label}</p><strong className="mt-1 block font-display text-4xl">{value}</strong></CardContent></Card>}
