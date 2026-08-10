import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { AutomationContext } from "@/components/automation-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { mavatApi, type SettingsData } from "@/lib/mavat-api";

export const Route = createFileRoute("/clients")({ component: ClientsPage });
const labels:Record<string,string>={client_name:"שם לקוח",id_number:"תז",block:"גוש",parcel:"חלקה",lot:"מגרש",locality:"יישוב",plan_number:"מספר תכנית",plan_name:"שם תכנית"};
function ClientsPage(){
  const inputRef=useRef<HTMLInputElement>(null);const [data,setData]=useState<SettingsData>({data_file:"",data_file_name:"",preview:[],error:"",run:{state:"idle",message:"",current_row:0,total_rows:0,manual_message:""}});const load=async()=>setData(await mavatApi<SettingsData>("/api/settings"));useEffect(()=>{load()},[]);
  const columns=useMemo(()=>Object.keys(data.preview[0]||{}).filter(x=>x!=="_row_number"),[data.preview]);
  const choose=async()=>{if(!window.mavatDesktop){inputRef.current?.click();return}const path=await window.mavatDesktop.selectDataFile();if(!path)return;try{const result=await mavatApi<{count:number;name:string}>("/api/settings/data-file",{method:"POST",body:JSON.stringify({path})});await load();toast.success(`נטענו ${result.count} רשומות מתוך ${result.name}`)}catch(e){toast.error((e as Error).message)}};
  const upload=async(file?:File)=>{if(!file)return;const form=new FormData();form.append("file",file);try{const response=await fetch("/api/settings/data-upload",{method:"POST",body:form});const result=await response.json();if(!response.ok||result.ok===false)throw new Error(result.error);await load();toast.success(`נטענו ${result.count} רשומות מתוך ${result.name}`)}catch(e){toast.error((e as Error).message)}};
  return <div className="mx-auto max-w-6xl space-y-8"><AutomationContext/><input ref={inputRef} hidden type="file" accept=".xlsx,.csv,.tsv,.docx" onChange={e=>upload(e.target.files?.[0])}/><PageHeader eyebrow="מקור נתונים" title="נתוני לקוחות" description="בחר קובץ Excel, CSV או Word עבור האוטומציה הפעילה. השורה הראשונה משמשת ככותרות והמערכת ממפה אותן למשתני התהליך." actions={<Button onClick={choose}><Upload className="size-4"/>טעינת קובץ</Button>}/>
    <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2 font-display text-xl"><FileSpreadsheet className="size-5 text-accent"/>קובץ פעיל</CardTitle><CardDescription>{data.data_file_name||"טרם נבחר קובץ"}</CardDescription></CardHeader><CardContent><p className="break-all text-xs text-muted-foreground" dir="ltr">{data.data_file}</p>{data.error&&<p className="mt-3 text-sm text-destructive">{data.error}</p>}</CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2 font-display text-xl"><FileText className="size-5 text-accent"/>עמודות מזוהות</CardTitle><CardDescription>מיפוי אוטומטי למשתני השלבים</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2">{columns.map(c=><Badge key={c} variant="outline">{labels[c]||c} <span className="me-1 font-mono text-[10px] text-muted-foreground">{`{${c}}`}</span></Badge>)}</CardContent></Card></div>
    <Card><CardHeader><CardTitle className="font-display text-xl">תצוגה מקדימה</CardTitle><CardDescription>עד חמש הרשומות הראשונות בקובץ; הנתונים המלאים נטענים בזמן ההרצה.</CardDescription></CardHeader><CardContent className="overflow-x-auto">{data.preview.length?<Table><TableHeader><TableRow>{columns.map(c=><TableHead key={c} className="text-right">{labels[c]||c}</TableHead>)}</TableRow></TableHeader><TableBody>{data.preview.map((row,i)=><TableRow key={i}>{columns.map(c=><TableCell key={c}>{String(row[c]??"")}</TableCell>)}</TableRow>)}</TableBody></Table>:<div className="py-20 text-center text-muted-foreground">בחר קובץ כדי לראות את הנתונים</div>}</CardContent></Card>
  </div>;
}
