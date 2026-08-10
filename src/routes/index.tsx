import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Building2, Clock, FileCheck2, Users } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "לוח בקרה — משרד טננבאום אדריכלות" },
      {
        name: "description",
        content: "מבט על תכניות פעילות, לקוחות והרצות מבא״ת אחרונות במשרד טננבאום אדריכלות.",
      },
      { property: "og:title", content: "לוח בקרה — משרד טננבאום אדריכלות" },
      {
        property: "og:description",
        content: "מבט על תכניות פעילות, לקוחות והרצות מבא״ת אחרונות.",
      },
    ],
  }),
  component: Index,
});

const stats = [
  { label: "תכניות פעילות", value: "18", icon: Building2, hint: "4 בהגשה החודש" },
  { label: "לקוחות רשומים", value: "126", icon: Users, hint: "9 חדשים ברבעון" },
  { label: "הגשות מבא״ת", value: "42", icon: FileCheck2, hint: "השנה" },
  { label: "שעות אוטומציה שנחסכו", value: "230", icon: Clock, hint: "מאז ההטמעה" },
];

const projects = [
  { name: "מגורים · רחוב הזית 12", city: "רעננה", status: "בהיתר", progress: 78 },
  { name: "תוספת בנייה · גוש 6412", city: "תל אביב", status: "בתכנון", progress: 42 },
  { name: "מבנה ציבור · שכונת נופים", city: "מודיעין", status: "בהגשה", progress: 90 },
  { name: "פיצול מגרש · חלקה 88", city: "כפר סבא", status: "בבדיקה", progress: 25 },
];

function Index() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="לוח בקרה"
        title="בוקר טוב, משרד טננבאום"
        description="תמונת מצב של התכניות, הלקוחות ותהליכי ההגשה האוטומטיים למבא״ת."
        actions={
          <Button asChild>
            <Link to="/run">
              הפעלת תהליך מבא״ת
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="surface-grain">
            <CardContent className="pt-6">
              <div className="flex items-center justify-start gap-3">
                <s.icon className="size-5 text-accent" />
                <span className="font-display text-3xl font-bold">{s.value}</span>
              </div>
              <p className="mt-3 text-sm font-medium">{s.label}</p>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-display">תכניות בתהליך</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {projects.map((p) => (
            <div key={p.name} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.city}</p>
                </div>
                <Badge variant="secondary">{p.status}</Badge>
              </div>
              <Progress value={p.progress} />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
