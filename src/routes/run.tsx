import { createFileRoute } from "@tanstack/react-router";
import { Chrome, Play, TestTube2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/run")({
  head: () => ({
    meta: [
      { title: "הפעלה — טננבאום אדריכלות" },
      {
        name: "description",
        content: "הפעלת תהליך מבא״ת במצב בדיקה או בדפדפן Chrome, כולל עצירות ידניות ומעקב התקדמות.",
      },
      { property: "og:title", content: "הפעלה — טננבאום אדריכלות" },
      { property: "og:description", content: "הפעלת תהליך מבא״ת במצב בדיקה או בדפדפן." },
    ],
  }),
  component: RunPage,
});

function RunPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        eyebrow="מנוע הרצה"
        title="הפעלה"
        description="התחל תמיד במצב בדיקה. לאחר אימות השלבים ניתן לבטל את מצב הבדיקה ולהריץ בדפדפן."
        actions={
          <>
            <Button variant="outline" onClick={() => toast("בדיקת Chrome — מצב הדגמה")}>
              <Chrome className="size-4" />
              בדיקת Chrome בלבד
            </Button>
            <Button onClick={() => toast.success("התהליך הופעל במצב בדיקה")}>
              <Play className="size-4" />
              התחל — פתח Chrome
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">הגדרות הרצה</CardTitle>
            <CardDescription>בחר חשבון וקבע את מצב ההרצה</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="google">חשבון Google להרצה</Label>
              <Input id="google" placeholder="office@tannenbaum.co.il" />
            </div>
            <div className="flex items-center justify-between rounded-md border border-accent/40 bg-accent/5 p-3">
              <div>
                <p className="text-sm font-medium">מצב בדיקה בלבד</p>
                <p className="text-xs text-muted-foreground">
                  מציג מה היה מתבצע, בלי לפתוח דפדפן ובלי לשלוח נתונים
                </p>
              </div>
              <Switch defaultChecked />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <p className="text-sm font-medium">צילום מסך בכל שלב</p>
              <Switch />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg">
              <TestTube2 className="size-5 text-accent" />
              מצב נוכחי
            </CardTitle>
            <CardDescription>ריצת בדיקה · 3 מתוך 7 שלבים</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={43} />
            <div className="rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-6">
              <p>[1] goto — נפתחה כתובת מבא״ת</p>
              <p>[2] fill_label — מולא שם משתמש</p>
              <p>[3] manual — ממתין לאימות דו-שלבי…</p>
            </div>
            <Button variant="secondary" className="w-full">
              המשך אחרי פעולה ידנית
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}