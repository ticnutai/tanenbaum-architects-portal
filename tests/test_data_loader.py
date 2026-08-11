import tempfile
import unittest
from pathlib import Path

from mavat_app.data_loader import _rows_to_records, load_csv


class DataLoaderTests(unittest.TestCase):
    def test_hebrew_headers_are_normalized(self) -> None:
        records = _rows_to_records([
            ["שם לקוח", 'ת"ז', "גוש", "חלקה"],
            ["ישראל ישראלי", "012345678", 100, 5],
        ])
        self.assertEqual(records, [{
            "client_name": "ישראל ישראלי",
            "id_number": "012345678",
            "block": 100,
            "parcel": 5,
            "_row_number": 2,
        }])

    def test_csv_semicolon(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "clients.csv"
            path.write_text("שם לקוח;גוש;חלקה\nלקוח א;12;3\n", encoding="utf-8-sig")
            records = load_csv(path)
        self.assertEqual(records[0]["client_name"], "לקוח א")
        self.assertEqual(records[0]["block"], "12")

    def test_planning_dropdown_headers_are_normalized(self) -> None:
        records = _rows_to_records([
            ["ועדה", "סוג תוכנית", "מרחב תכנון", "שטח בדונם"],
            ["שדות דן", "תוכנית מתאר מקומית", "אור יהודה", 12.5],
        ])
        self.assertEqual(records[0]["committee"], "שדות דן")
        self.assertEqual(records[0]["plan_type"], "תוכנית מתאר מקומית")
        self.assertEqual(records[0]["planning_area"], "אור יהודה")
        self.assertEqual(records[0]["area"], 12.5)


if __name__ == "__main__":
    unittest.main()
