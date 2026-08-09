import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "הגדרות — טננבאום אדריכלות" },
      {
        name: "description",
        content: "הגדרות המשרד והמערכת: פרטי משרד, כתובת מבא״ת, תיקיית פלט והתנהגות ברירת מחדל.",
      },
      { property: "og:title", content: "הגדרות — טננבאום אדריכלות" },
      { property: "og:description", content: "הגדרות המשרד ותצורת המערכת." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader eyebrow="תצורה" title="הגדרות" description="פרטי המשרד והתנהגות ברירת המחדל." />
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-lg">פרטי משרד</CardTitle>
          <CardDescription>מוצגים בכותרות ובדוחות</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="office">שם המשרד</Label>
            <Input id="office" defaultValue="משרד טננבאום אדריכלות" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mavat">כתובת מבא״ת</Label>
            <Input id="mavat" defaultValue="https://mavat.iplan.gov.il" dir="ltr" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="out">תיקיית פלט</Label>
            <Input id="out" defaultValue="C:\\Tannenbaum\\runs" dir="ltr" />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">התחל תמיד במצב בדיקה</p>
              <p className="text-xs text-muted-foreground">מומלץ להשאיר פעיל</p>
            </div>
            <Switch defaultChecked />
          </div>
          <Button>שמירת הגדרות</Button>
        </CardContent>
      </Card>
    </div>
  );
}