import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { AutomationContext } from "@/components/automation-context";
import { ChromeProfiles } from "@/components/chrome-profiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mavatApi, type WorkflowData } from "@/lib/mavat-api";

export const Route = createFileRoute("/profiles")({ component: ProfilesPage });
function ProfilesPage(){
  const [profiles,setProfiles]=useState<WorkflowData["profiles"]>({});const [id,setId]=useState("");const [name,setName]=useState("");const [username,setUsername]=useState("");const [password,setPassword]=useState("");const [confirm,setConfirm]=useState("");const [show,setShow]=useState(false);
  const load=async()=>{const data=await mavatApi<WorkflowData>("/api/workflow");setProfiles(data.profiles)};useEffect(()=>{load()},[]);
  const choose=(profileId:string)=>{const p=profiles[profileId];setId(profileId);setName(p?.name||"");setUsername(p?.username||"");setPassword("");setConfirm("")};
  const reset=()=>{setId("");setName("");setUsername("");setPassword("");setConfirm("")};
  const save=async()=>{try{await mavatApi("/api/credentials",{method:"POST",body:JSON.stringify({profile_id:id||null,name,username,password,confirm_password:confirm})});await load();reset();toast.success("הפרופיל והסיסמה נשמרו") }catch(e){toast.error((e as Error).message)}};
  const remove=async()=>{if(!id||!confirmDelete())return;await mavatApi(`/api/credentials/${id}/password`,{method:"DELETE"});await load();reset();toast.success("הסיסמה נמחקה")};
  return <div className="mx-auto max-w-5xl space-y-8"><AutomationContext/><PageHeader eyebrow="כניסה לאתר" title="חשבונות התחברות לאתר" description="בחר את פרופיל Chrome ואת חשבון האתר שהאוטומציה תשתמש בהם."/><ChromeProfiles/>
    <Card className="border-accent/30 bg-accent/5"><CardContent className="flex items-start gap-3 pt-6"><ShieldCheck className="mt-0.5 size-5 text-accent"/><p className="text-sm text-muted-foreground">קוד חד-פעמי, ביומטריה ו-CAPTCHA נשארים פעולות ידניות ולעולם אינם נשמרים במערכת.</p></CardContent></Card>
    <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle className="font-display text-xl">{id?"עריכת פרופיל":"פרופיל חדש"}</CardTitle><CardDescription>{id?"הזן סיסמה חדשה או השאר ריק כדי לשמור את הקיימת.":"צור פרופיל שאפשר לקשר לשלבי סיסמה."}</CardDescription></CardHeader><CardContent className="space-y-4"><Field label="שם פרופיל"><Input value={name} onChange={e=>setName(e.target.value)} placeholder="מבא״ת — משרד ראשי"/></Field><Field label="שם משתמש / תעודת זהות"><Input value={username} onChange={e=>setUsername(e.target.value)}/></Field><Field label="סיסמה"><div className="relative"><Input className="pl-10" type={show?"text":"password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder={id&&profiles[id]?.has_password?"השאר ריק לשמירת הקיימת":"••••••••"}/><button className="absolute left-3 top-2.5 text-muted-foreground" onClick={()=>setShow(!show)}>{show?<EyeOff className="size-4"/>:<Eye className="size-4"/>}</button></div></Field><Field label="אימות סיסמה"><Input type={show?"text":"password"} value={confirm} onChange={e=>setConfirm(e.target.value)}/></Field><div className="flex gap-2"><Button className="flex-1" onClick={save}><KeyRound className="size-4"/>שמירת פרופיל</Button>{id&&<Button variant="destructive" onClick={remove}><Trash2 className="size-4"/>מחק סיסמה</Button>}</div></CardContent></Card>
    <Card><CardHeader><CardTitle className="font-display text-xl">פרופילים קיימים</CardTitle><CardDescription>לחץ על פרופיל כדי לערוך או להחליף סיסמה.</CardDescription></CardHeader><CardContent className="space-y-3">{Object.entries(profiles).map(([key,p])=><button key={key} onClick={()=>choose(key)} className={`flex w-full items-center justify-between rounded-md border p-4 text-right transition-colors hover:border-accent/60 ${id===key?"border-primary bg-primary/5":"border-border"}`}><div><p className="font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{p.username}</p></div><Badge variant={p.has_password?"secondary":"destructive"}>{p.has_password?"סיסמה שמורה":"ללא סיסמה"}</Badge></button>)}{!Object.keys(profiles).length&&<p className="py-12 text-center text-muted-foreground">טרם נוצרו פרופילים</p>}</CardContent></Card></div>
  </div>;
}
function Field({label,children}:{label:string;children:React.ReactNode}){return <div className="space-y-2"><Label>{label}</Label>{children}</div>}
function confirmDelete(){return window.confirm("למחוק את הסיסמה השמורה? הפרופיל יישאר ללא סיסמה.")}
