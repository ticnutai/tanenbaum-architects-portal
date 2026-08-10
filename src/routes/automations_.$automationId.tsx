import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bot, FileSpreadsheet, KeyRound, ListOrdered, PlayCircle, ScrollText } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { mavatApi, type AutomationsData, type AutomationSummary } from "@/lib/mavat-api";

export const Route = createFileRoute("/automations_/$automationId")({
  component: AutomationWorkspace,
});

const sections = [
  {
    order: 1,
    title: "כניסה לאתר",
    description: "פרופיל Chrome, שם משתמש וסיסמה מאובטחת",
    icon: KeyRound,
    to: "/profiles" as const,
    action: "הגדרת כניסה",
  },
  {
    order: 2,
    title: "שלבי עבודה",
    description: "הקלטה, עריכה וסידור של הפעולות באתר",
    icon: ListOrdered,
    to: "/workflow" as const,
    action: "עריכת השלבים",
  },
  {
    order: 3,
    title: "מקור נתונים",
    description: "בחירת Excel, CSV או Word והתאמת נתוני הלקוחות",
    icon: FileSpreadsheet,
    to: "/clients" as const,
    action: "בחירת נתונים",
  },
  {
    order: 4,
    title: "הפעלה",
    description: "בדיקה או הרצה אמיתית, עצירה והמשך",
    icon: PlayCircle,
    to: "/run" as const,
    action: "מעבר להפעלה",
  },
  {
    order: 5,
    title: "יומן ריצה",
    description: "תוצאות, שגיאות, צילומי מסך וקונסול",
    icon: ScrollText,
    to: "/logs" as const,
    action: "פתיחת היומן",
  },
];

function AutomationWorkspace() {
  const { automationId } = Route.useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<AutomationSummary | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        await mavatApi(`/api/automations/${automationId}/activate`, { method: "POST" });
        const data = await mavatApi<AutomationsData>("/api/automations");
        const automation = data.automations.find((candidate) => candidate.id === automationId);
        if (!automation) throw new Error("האוטומציה לא נמצאה");
        setItem(automation);
      } catch (error) {
        toast.error((error as Error).message || "לא ניתן לפתוח את האוטומציה");
        await navigate({ to: "/automations" });
      }
    };
    void load();
  }, [automationId, navigate]);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="סביבת אוטומציה"
        title={item?.name || "טוען אוטומציה…"}
        description={item?.description || "הגדר את התהליך לפי הסדר, ולאחר מכן בצע הרצת בדיקה."}
      />
      <Card className="border-primary/25 bg-primary/5">
        <CardContent className="flex flex-wrap items-center gap-4 py-5">
          <span className="flex size-12 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-6" />
          </span>
          <div className="flex-1">
            <p className="font-semibold">האוטומציה הזאת פעילה כעת במנוע Python</p>
            <p className="text-sm text-muted-foreground">
              כל שינוי בשלבים וכל הרצה יתבצעו עבורה בלבד.
            </p>
          </div>
          <Badge variant="secondary">{item?.steps_count ?? 0} שלבים</Badge>
        </CardContent>
      </Card>
      <div className="relative grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {sections.map((section) => (
          <Card key={section.order} className="group flex min-h-60 flex-col">
            <CardHeader>
              <div className="mb-3 flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-md bg-muted text-primary group-hover:bg-primary group-hover:text-primary-foreground">
                  <section.icon className="size-5" />
                </span>
                <span className="font-display text-3xl font-bold text-muted-foreground/30">
                  {section.order}
                </span>
              </div>
              <CardTitle className="font-display text-xl">{section.title}</CardTitle>
              <CardDescription className="leading-6">{section.description}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto">
              <Button variant="outline" className="w-full" asChild>
                <Link to={section.to}>{section.action}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="rounded-md border border-accent/30 bg-accent/5 p-4 text-sm">
        <strong>סדר עבודה מומלץ:</strong> הגדר כניסה → הקלט או ערוך את השלבים → בחר קובץ נתונים →
        בצע בדיקה → עבור להרצה אמיתית.
      </div>
    </div>
  );
}
