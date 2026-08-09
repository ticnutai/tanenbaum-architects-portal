import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/projects")({
  head: () => ({
    meta: [
      { title: "תכניות ופרויקטים — טננבאום אדריכלות" },
      {
        name: "description",
        content: "רשימת התכניות והפרויקטים של המשרד, כולל גוש, חלקה וסטטוס הגשה.",
      },
      { property: "og:title", content: "תכניות ופרויקטים — טננבאום אדריכלות" },
      { property: "og:description", content: "ניהול תכניות, גוש וחלקה וסטטוס הגשה." },
    ],
  }),
  component: ProjectsPage,
});

const rows = [
  { plan: "301-0912345", name: "הזית 12", block: "6412", parcel: "104", lot: "12", city: "רעננה", status: "בהיתר" },
  { plan: "301-0998211", name: "תוספת קומה", block: "7104", parcel: "56", lot: "3", city: "תל אביב", status: "בתכנון" },
  { plan: "302-0771120", name: "מבנה ציבור נופים", block: "5588", parcel: "12", lot: "7", city: "מודיעין", status: "בהגשה" },
  { plan: "304-0665412", name: "פיצול מגרש", block: "6901", parcel: "88", lot: "2", city: "כפר סבא", status: "בבדיקה" },
];

function ProjectsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="תיק משרד"
        title="תכניות ופרויקטים"
        description="כל התכניות של המשרד במקום אחד — מספר תכנית, גוש, חלקה, מגרש וסטטוס."
        actions={<Button variant="outline">תכנית חדשה</Button>}
      />
      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">מספר תכנית</TableHead>
                <TableHead className="text-right">שם תכנית</TableHead>
                <TableHead className="text-right">גוש</TableHead>
                <TableHead className="text-right">חלקה</TableHead>
                <TableHead className="text-right">מגרש</TableHead>
                <TableHead className="text-right">יישוב</TableHead>
                <TableHead className="text-right">סטטוס</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.plan}>
                  <TableCell className="font-mono text-xs">{r.plan}</TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.block}</TableCell>
                  <TableCell>{r.parcel}</TableCell>
                  <TableCell>{r.lot}</TableCell>
                  <TableCell>{r.city}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{r.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}