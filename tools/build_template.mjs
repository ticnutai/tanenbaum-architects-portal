import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = fileURLToPath(new URL("../outputs/", import.meta.url));
await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("לקוחות");
sheet.showGridLines = false;
sheet.getRange("A1:H4").values = [
  ["שם לקוח", "תז", "גוש", "חלקה", "מגרש", "יישוב", "מספר תכנית", "שם תכנית"],
  ["לקוח לדוג", "012345678", 10000, 12, "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
];
sheet.getRange("A1:H1").format = {
  fill: "#1769AA",
  font: { bold: true, color: "#FFFFFF", size: 11 },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "outside", style: "thin", color: "#0E4775" },
};
sheet.getRange("A2:H4").format = {
  fill: "#F7FAFC",
  font: { color: "#19324A", size: 10 },
  horizontalAlignment: "right",
  verticalAlignment: "center",
  borders: { preset: "inside", style: "thin", color: "#D8E2EC" },
};
sheet.getRange("B2:B4").format.numberFormat = "@";
sheet.getRange("C2:D4").format.numberFormat = "0";
sheet.getRange("A1:H4").format.rowHeight = 24;
sheet.getRange("A:A").format.columnWidth = 20;
sheet.getRange("B:B").format.columnWidth = 16;
sheet.getRange("C:D").format.columnWidth = 12;
sheet.getRange("E:F").format.columnWidth = 16;
sheet.getRange("G:H").format.columnWidth = 22;
sheet.freezePanes.freezeRows(1);
const table = sheet.tables.add("A1:H4", true, "MavatClientsTable");
table.style = "TableStyleMedium2";
table.showFilterButton = true;

const instructions = workbook.worksheets.add("הוראות");
instructions.showGridLines = false;
instructions.getRange("A1:D1").merge();
instructions.getRange("A1").values = [["הוראות למילוי קובץ לקוחות למערכת מבא״ת"]];
instructions.getRange("A1:D1").format = {
  fill: "#143B63",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "right",
  verticalAlignment: "center",
};
instructions.getRange("A3:B10").values = [
  ["כלל", "הסבר"],
  ["שורה ראשונה", "אין לשנות את שמות הכותרות."],
  ["תעודת זהות", "יש להזין כטקסט כדי לשמור אפס מוביל."],
  ["גוש וחלקה", "יש להזין מספרים בלבד."],
  ["שורה ריקה", "שורות ריקות לא ייקלטו."],
  ["סיסמאות", "אין להכניס סיסמאות לקובץ זה."],
  ["בדיקה", "יש להריץ תחילה במצב בדיקה בלבד."],
  ["גיבוי", "שמור עותק של הקובץ המקורי לפני הרצה."],
];
instructions.getRange("A3:B3").format = { fill: "#1769AA", font: { bold: true, color: "#FFFFFF" } };
instructions.getRange("A4:B10").format = { fill: "#F7FAFC", wrapText: true, verticalAlignment: "top" };
instructions.getRange("A3:B10").format.borders = { preset: "inside", style: "thin", color: "#D8E2EC" };
instructions.getRange("A:A").format.columnWidth = 22;
instructions.getRange("B:B").format.columnWidth = 55;
instructions.getRange("A1:D1").format.rowHeight = 36;

const preview = await workbook.render({ sheetName: "לקוחות", range: "A1:H4", scale: 2, format: "png" });
await fs.writeFile(path.join(outputDir, "mavat_clients_template_preview.png"), new Uint8Array(await preview.arrayBuffer()));

const inspect = await workbook.inspect({ kind: "table", range: "לקוחות!A1:H4", include: "values,formulas", tableMaxRows: 10, tableMaxCols: 10 });
console.log(inspect.ndjson);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 50 }, summary: "final formula error scan" });
console.log(errors.ndjson);

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(outputDir, "mavat_clients_template.xlsx"));
