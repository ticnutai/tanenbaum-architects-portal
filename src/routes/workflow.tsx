import { createFileRoute } from "@tanstack/react-router";
import { Circle, GripVertical, Plus, Radio } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/workflow")({
  head: () => ({
    meta: [
      { title: "שלבי עבודה — טננבאום אדריכלות" },
      {
        name: "description",
        content: "עריכה, סידור והקלטה של שלבי תהליך מבא״ת: ניווט, לחיצה, מילוי שדות ועצירות ידניות.",
      },
      { property: "og:title", content: "שלבי עבודה — טננבאום אדריכלות" },
      { property: "og:description", content: "עריכה והקלטה של שלבי תהליך מבא״ת." },
    ],
  }),
  component: WorkflowPage,
});

const steps = [
  { type: "goto", label: "פתיחת כתובת מבא״ת", detail: "https://mavat.iplan.gov.il" },
  { type: "fill_label", label: "מילוי שם משתמש", detail: "{username}" },
  { type: "fill_secret", label: "מילוי סיסמה מאחסון מאובטח", detail: "מוסתר" },
  { type: "manual", label: "אימות דו-שלבי", detail: "עצירה לפעולת משתמש" },
  { type: "wait_text", label: "המתנה למסך תכניות", detail: "רשימת תכניות" },
  { type: "fill_placeholder", label: "חיפוש לפי גוש/חלקה", detail: "{block} / {parcel}" },
  { type: "screenshot", label: "צילום מסך לתיעוד", detail: "run/{client_name}.png" },
];

const typeTone: Record<string, string> = {
  manual: "destructive",
  fill_secret: "default",
};

function WorkflowPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        eyebrow="תהליך"
        title="שלבי עבודה"
        description="ערוך, הוסף וסדר את פעולות האתר. ניתן להקליט הדגמה בדפדפן — ערכים שהוקלדו אינם נשמרים."
        actions={
          <>
            <Button variant="outline">
              <Radio className="size-4" />
              התחל הקלטת פעולות
            </Button>
            <Button>
              <Plus className="size-4" />
              שלב חדש
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="font-display">רשימת השלבים</CardTitle>
          <CardDescription>
            גרור לשינוי סדר · מקש רווח מפעיל או משהה · Delete מוחק את הבחירה
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {steps.map((s, i) => (
            <div
              key={s.label}
              className="flex items-center gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:border-accent/50"
            >
              <GripVertical className="size-4 text-muted-foreground" />
              <span className="w-6 text-center font-mono text-xs text-muted-foreground">
                {i + 1}
              </span>
              <Circle className="size-2 fill-accent text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.label}</p>
                <p className="truncate text-xs text-muted-foreground">{s.detail}</p>
              </div>
              <Badge variant={typeTone[s.type] === "destructive" ? "destructive" : "secondary"}>
                {s.type}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}