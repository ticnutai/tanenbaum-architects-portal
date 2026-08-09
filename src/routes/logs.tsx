import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/logs")({
  head: () => ({
    meta: [
      { title: "יומן ריצה — טננבאום אדריכלות" },
      {
        name: "description",
        content: "היסטוריית ההרצות של תהליך מבא״ת: זמן, לקוח, מצב ותוצאה.",
      },
      { property: "og:title", content: "יומן ריצה — טננבאום אדריכלות" },
      { property: "og:description", content: "היסטוריית ההרצות של תהליך מבא״ת." },
    ],
  }),
  component: LogsPage,
});

const runs = [
  { time: "09/08 14:22", client: "דנה כהן", mode: "דפדפן", result: "הושלם" },
  { time: "09/08 11:05", client: "אבי לוי", mode: "בדיקה", result: "הושלם" },
  { time: "08/08 17:40", client: "משפחת ברק", mode: "דפדפן", result: "נעצר ידנית" },
  { time: "08/08 09:12", client: "דנה כהן", mode: "בדיקה", result: "שגיאה" },
];

function LogsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader eyebrow="תיעוד" title="יומן ריצה" description="כל הרצה נשמרת עם השלבים שבוצעו." />
      <Card>
        <CardContent className="divide-y divide-border pt-2">
          {runs.map((r) => (
            <div key={r.time} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium">{r.client}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {r.time} · {r.mode}
                </p>
              </div>
              <Badge variant={r.result === "שגיאה" ? "destructive" : "secondary"}>{r.result}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}