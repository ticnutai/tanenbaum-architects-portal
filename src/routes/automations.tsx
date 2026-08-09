import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Bot, Copy, ListOrdered, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/automations")({
  head: () => ({
    meta: [
      { title: "פרופילי אוטומציה — טננבאום אדריכלות" },
      {
        name: "description",
        content:
          "בניית פרופילי אוטומציה: כל פרופיל מכיל רצף פעולות משלו שניתן להריץ בנפרד באתר מבא״ת.",
      },
      { property: "og:title", content: "פרופילי אוטומציה — טננבאום אדריכלות" },
      { property: "og:description", content: "בניית רצפי פעולות אוטומטיים והרצתם בנפרד." },
    ],
  }),
  component: AutomationsPage,
});

type Automation = {
  id: string;
  name: string;
  description: string;
  steps: string[];
  lastRun: string;
  active: boolean;
};

const initialAutomations: Automation[] = [
  {
    id: "a1",
    name: "כניסה למבא״ת",
    description: "התחברות מלאה כולל עצירה לאימות דו-שלבי",
    steps: ["goto — כתובת מבא״ת", "fill_label — שם משתמש", "fill_secret — סיסמה", "manual — קוד חד-פעמי"],
    lastRun: "היום, 09:14",
    active: true,
  },
  {
    id: "a2",
    name: "חיפוש גוש/חלקה",
    description: "איתור תכנית לפי נתוני הלקוח ושמירת צילום מסך",
    steps: ["wait_text — מסך תכניות", "fill_placeholder — {block}/{parcel}", "click — חיפוש", "screenshot — תיעוד"],
    lastRun: "אתמול, 16:40",
    active: true,
  },
  {
    id: "a3",
    name: "הורדת מסמכי תכנית",
    description: "מעבר על טאב המסמכים והורדת כל הקבצים",
    steps: ["click — טאב מסמכים", "loop — הורדת קבצים", "screenshot — אישור"],
    lastRun: "לא הורץ",
    active: false,
  },
];

function AutomationsPage() {
  const [automations, setAutomations] = useState(initialAutomations);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");

  const addAutomation = () => {
    if (!name.trim()) {
      toast.error("יש להזין שם לפרופיל האוטומציה");
      return;
    }
    setAutomations((prev) => [
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        description: description.trim() || "ללא תיאור",
        steps: steps
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        lastRun: "לא הורץ",
        active: false,
      },
      ...prev,
    ]);
    setName("");
    setDescription("");
    setSteps("");
    toast.success("פרופיל אוטומציה נוצר");
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="אוטומציה"
        title="פרופילי אוטומציה"
        description="כל פרופיל הוא רצף פעולות עצמאי. אפשר לבנות כמה פרופילים שרוצים ולהריץ כל אחד בנפרד."
        actions={
          <Button onClick={() => document.getElementById("new-automation")?.scrollIntoView({ behavior: "smooth" })}>
            <Plus className="size-4" />
            פרופיל אוטומציה חדש
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {automations.map((a) => (
          <Card key={a.id} className="flex flex-col">
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="flex items-center gap-2 font-display text-lg">
                  <Bot className="size-5 text-accent" />
                  {a.name}
                </CardTitle>
                <Badge variant={a.active ? "secondary" : "outline"}>
                  {a.active ? "פעיל" : "טיוטה"}
                </Badge>
              </div>
              <CardDescription>{a.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-6">
                {a.steps.map((s, i) => (
                  <p key={s} className="truncate">
                    [{i + 1}] {s}
                  </p>
                ))}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ListOrdered className="size-3.5" />
                {a.steps.length} שלבים · הרצה אחרונה: {a.lastRun}
              </div>
              <div className="mt-auto flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => toast.success(`"${a.name}" הופעל במצב בדיקה`)}
                >
                  <Play className="size-4" />
                  הרץ
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAutomations((prev) => [
                      { ...a, id: crypto.randomUUID(), name: `${a.name} — עותק`, active: false },
                      ...prev,
                    ]);
                    toast("שוכפל פרופיל");
                  }}
                >
                  <Copy className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAutomations((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card id="new-automation">
        <CardHeader>
          <CardTitle className="font-display text-lg">בניית פרופיל אוטומציה</CardTitle>
          <CardDescription>הזן שם, תיאור ורצף שלבים — שלב אחד בכל שורה.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="auto-name">שם הפרופיל</Label>
              <Input
                id="auto-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="הגשת בקשה חדשה"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auto-desc">תיאור</Label>
              <Input
                id="auto-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="מה הפרופיל עושה"
              />
            </div>
            <Button className="w-full" onClick={addAutomation}>
              <Plus className="size-4" />
              שמירת פרופיל
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="auto-steps">שלבים</Label>
            <Textarea
              id="auto-steps"
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              rows={9}
              className="font-mono text-xs"
              placeholder={"goto — כתובת מבא״ת\nclick — כפתור הגשה\nmanual — אישור משתמש"}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}