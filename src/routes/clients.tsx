import { createFileRoute } from "@tanstack/react-router";
import { FileSpreadsheet, FileText, Upload } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/clients")({
  head: () => ({
    meta: [
      { title: "נתוני לקוחות — טננבאום אדריכלות" },
      {
        name: "description",
        content: "טעינת רשומות לקוחות מקבצי Excel, CSV או Word ומיפוי העמודות לתהליך מבא״ת.",
      },
      { property: "og:title", content: "נתוני לקוחות — טננבאום אדריכלות" },
      { property: "og:description", content: "טעינת רשומות לקוחות מ-Excel, CSV או Word." },
    ],
  }),
  component: ClientsPage,
});

const columns = ["שם לקוח", "תז", "גוש", "חלקה", "מגרש", "יישוב", "מספר תכנית", "שם תכנית"];

const clients = [
  { name: "דנה כהן", id: "0••••4821", block: "6412", parcel: "104", city: "רעננה" },
  { name: "אבי לוי", id: "0••••1190", block: "7104", parcel: "56", city: "תל אביב" },
  { name: "משפחת ברק", id: "0••••7734", block: "5588", parcel: "12", city: "מודיעין" },
];

function ClientsPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="מקור נתונים"
        title="נתוני לקוחות"
        description="בחר קובץ Excel, CSV או Word. ב-Excel השורה הראשונה היא כותרות; ב-Word הנתונים חייבים להיות בטבלה."
        actions={
          <Button>
            <Upload className="size-4" />
            טעינת קובץ
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg">
              <FileSpreadsheet className="size-5 text-accent" />
              קובץ פעיל
            </CardTitle>
            <CardDescription>clients_2026.xlsx · 126 רשומות · נטען היום</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg">
              <FileText className="size-5 text-accent" />
              עמודות מזוהות
            </CardTitle>
            <CardDescription>מיפוי אוטומטי למשתני השלבים</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {columns.map((c) => (
              <Badge key={c} variant="outline">
                {c}
              </Badge>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-display">תצוגה מקדימה</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">שם לקוח</TableHead>
                <TableHead className="text-right">תז</TableHead>
                <TableHead className="text-right">גוש</TableHead>
                <TableHead className="text-right">חלקה</TableHead>
                <TableHead className="text-right">יישוב</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">{c.id}</TableCell>
                  <TableCell>{c.block}</TableCell>
                  <TableCell>{c.parcel}</TableCell>
                  <TableCell>{c.city}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}