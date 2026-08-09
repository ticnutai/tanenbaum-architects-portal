import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/profiles")({
  head: () => ({
    meta: [
      { title: "פרופילי כניסה — טננבאום אדריכלות" },
      {
        name: "description",
        content: "ניהול פרופילי כניסה לאתר מבא״ת עם שמירת סיסמה מאובטחת ואימות דו-שלבי ידני.",
      },
      { property: "og:title", content: "פרופילי כניסה — טננבאום אדריכלות" },
      { property: "og:description", content: "ניהול פרופילי כניסה ושמירת סיסמה מאובטחת." },
    ],
  }),
  component: ProfilesPage,
});

const profiles = [
  { name: "מבא״ת — משרד ראשי", user: "office@tannenbaum.co.il", saved: true },
  { name: "מבא״ת — אדריכל אחראי", user: "arch@tannenbaum.co.il", saved: false },
];

function ProfilesPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        eyebrow="אבטחה"
        title="פרופילי כניסה"
        description="הסיסמה אינה נשמרת בקוד או בקבצי התהליך. שמירה מאובטחת מתבצעת דרך מנהל האישורים של Windows."
      />

      <Card className="border-accent/30 bg-accent/5">
        <CardContent className="flex items-start gap-3 pt-6">
          <ShieldCheck className="mt-0.5 size-5 text-accent" />
          <p className="text-sm text-muted-foreground">
            קוד חד-פעמי, ביומטריה ו-CAPTCHA נשארים פעולות ידניות ולעולם אינם מאוחסנים במערכת.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">פרופיל חדש</CardTitle>
            <CardDescription>הזן שם פרופיל, חשבון וסיסמה בשדה מוסתר.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="profile-name">שם פרופיל</Label>
              <Input id="profile-name" placeholder="מבא״ת — משרד ראשי" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-user">חשבון / דוא״ל</Label>
              <Input id="profile-user" type="email" placeholder="office@tannenbaum.co.il" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-pass">סיסמה</Label>
              <Input id="profile-pass" type="password" placeholder="••••••••" />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">שמירה מאובטחת</p>
                <p className="text-xs text-muted-foreground">Windows Credential Manager</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Button className="w-full">שמירת פרופיל</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">פרופילים קיימים</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {profiles.map((p) => (
              <div
                key={p.user}
                className="flex items-center justify-between rounded-md border border-border p-3"
              >
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.user}</p>
                </div>
                <Badge variant={p.saved ? "secondary" : "outline"}>
                  {p.saved ? "סיסמה שמורה" : "ללא סיסמה"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}