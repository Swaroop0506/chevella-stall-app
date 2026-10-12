"""Regression tests built from cards actually scanned at the stall.

Each case is the real block geometry PP-OCRv5 returned, with the correct answer written
down by eye from the photo. These are the ground truth the field extractor is measured
against — when a card parses badly in the field, add it here first, then fix the parser.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import parse_card  # noqa: E402


def box(text, x, y, w, h, score=0.97):
    return {"text": text, "score": score,
            "box": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]}


# A two-column card: company block on the left, person and address on the right.
GM_WATER = [
    box("HUSEN MUJAWAR",               703,  799, 276, 33),
    box("Assistant Manager- Projects", 703,  835, 301, 30),
    box("+91 8454095907",              705,  877, 237, 32),
    box("GM Water",                    124,  892, 299, 64),
    box("husen.mujawar@gmwaterin",     705,  918, 321, 36),
    box("& Process Technologies",      128,  942, 290, 38),
    box("GM Water & Process",          118, 1111, 338, 39),
    box("B/51&52, Platinum Springs,",  663, 1103, 346, 39),
    box("Plot No-6, G-20 to G-24,",    663, 1139, 292, 37),
    box("Technologies Pvt. Ltd.",      118, 1151, 339, 51),
    box("MIDC Taloja -410208,",        664, 1176, 273, 38),
    box("Maharashtra.",                665, 1216, 168, 33),
    box("www.gmwater.in",              171, 1288, 234, 45),
]

# Single column, name in caps, GST and pincode run together on one line.
JEEVA = [
    box("KISHORE CHAKRAVARTHY",                                      60,  80, 420, 38),
    box("Ph:9849617398",                                             60, 150, 230, 30),
    box("jeevahealthcare16@gmail.com",                               60, 195, 380, 30),
    box("Jeeva Healthcare",                                          60, 260, 300, 44),
    box("Surgical &r Medical distributors",                          60, 315, 330, 26),
    box("Reg Off:9-6-72,Rd no:2,Durga Bhavani Nagar,Champapet,Hyderabad.", 60, 380, 620, 24),
    box("Pin:500059. GST:36AHDPC7598K1ZV.",                          60, 415, 420, 24),
]

# No person and no contact details at all — a pure marketing side.
ROYAL = [
    box("Authorised Distributors for:",               60,  70, 280, 24),
    box("OxyCare",                                    60, 110, 140, 30),
    box("ROYAL",                                     400, 300, 200, 50),
    box("SURGICARE PVT.LTD.",                        400, 360, 330, 44),
    box("Manufacturers of Surgical dressings",        60, 440, 360, 22),
    box("Pralonged Surgery Care",                     60, 200, 250, 24),
]


class TestGmWaterTwoColumn(unittest.TestCase):
    def setUp(self):
        self.f = parse_card(GM_WATER).fields

    def test_name_is_the_person_not_the_state(self):
        self.assertEqual(self.f.get("full_name"), "Husen Mujawar")

    def test_designation(self):
        self.assertEqual(self.f.get("designation"), "Assistant Manager- Projects")

    def test_company_spans_two_lines(self):
        self.assertIn("GM Water", self.f.get("company", ""))

    def test_phone(self):
        self.assertEqual(self.f.get("phone_primary"), "+918454095907")

    def test_email_missing_dot_is_repaired(self):
        self.assertEqual(self.f.get("email"), "husen.mujawar@gmwater.in")

    def test_state_and_pincode(self):
        self.assertEqual(self.f.get("state"), "Maharashtra")
        self.assertEqual(self.f.get("pincode"), "410208")


class TestJeeva(unittest.TestCase):
    def setUp(self):
        self.res = parse_card(JEEVA)

    def test_fields(self):
        f = self.res.fields
        self.assertEqual(f.get("full_name"), "Kishore Chakravarthy")
        self.assertEqual(f.get("phone_primary"), "+919849617398")
        self.assertEqual(f.get("email"), "jeevahealthcare16@gmail.com")
        self.assertEqual(f.get("gstin"), "36AHDPC7598K1ZV")
        self.assertEqual(f.get("pincode"), "500059")
        self.assertEqual(f.get("city"), "Hyderabad")
        self.assertIn("Jeeva", f.get("company", ""))

    def test_gst_line_is_not_part_of_the_address(self):
        self.assertNotIn("GST", self.res.fields.get("address", ""))


class TestRoyalMarketingSide(unittest.TestCase):
    def setUp(self):
        self.res = parse_card(ROYAL)

    def test_no_person_is_invented(self):
        # The card names no individual. A distributor's brand is not a contact.
        self.assertIsNone(self.res.fields.get("full_name"))

    def test_company_name_is_rejoined(self):
        self.assertIn("Royal", self.res.fields.get("company", ""))
        self.assertIn("Surgicare", self.res.fields.get("company", ""))

    def test_flagged_for_review(self):
        # No phone and no email: a human has to look at this one.
        self.assertTrue(self.res.needs_review)


if __name__ == "__main__":
    unittest.main(verbosity=2)
