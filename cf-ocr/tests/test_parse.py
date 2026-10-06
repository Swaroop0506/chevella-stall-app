"""Field-extraction tests.

These run without the OCR engine: each case is the block list a real card produces, so the
parser can be regression-tested on a laptop in milliseconds. When a real card parses badly
at the event, add its blocks here as a new case before changing the heuristics.

    python3 -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import (  # noqa: E402
    address_score, company_score, designation_score, extract_emails, extract_phones,
    fix_email_ocr, looks_like_person_name, name_from_email, parse_card, split_address,
    to_e164, Line,
)


def blocks(*lines):
    """Lays text out as if it came off a card: one line per row, descending the image."""
    out = []
    y = 20.0
    for item in lines:
        text, h = item if isinstance(item, tuple) else (item, 24.0)
        out.append({
            "text": text,
            "score": 0.97,
            "box": [[40.0, y], [40.0 + 9 * len(text), y], [40.0 + 9 * len(text), y + h], [40.0, y + h]],
        })
        y += h + 10
    return out


class TestPhone(unittest.TestCase):
    def test_indian_forms(self):
        for raw in ["9701221934", "097012 21934", "+91 97012 21934", "0091-9701221934",
                    "919701221934", "+919701221934", "97012-21934"]:
            self.assertEqual(to_e164(raw), "+919701221934", raw)

    def test_landline(self):
        self.assertEqual(to_e164("040-23456789"), "+914023456789")

    def test_international_kept(self):
        self.assertEqual(to_e164("+971 50 123 4567"), "+971501234567")

    def test_rejects_rubbish(self):
        self.assertIsNone(to_e164(""))
        self.assertIsNone(to_e164("abc"))

    def test_ocr_letter_confusion(self):
        self.assertEqual(to_e164("97O1221934"), "+919701221934")

    def test_labels_do_not_become_digits(self):
        got = extract_phones([Line(text="Mobile: 98765 43210", score=0.98)])
        self.assertEqual(got["mobiles"], ["+919876543210"])

    def test_two_numbers_on_one_line(self):
        got = extract_phones([Line(text="Ph: 9701221934 / 9701221935", score=0.98)])
        self.assertEqual(got["mobiles"], ["+919701221934", "+919701221935"])

    def test_whatsapp_label_wins(self):
        got = extract_phones([
            Line(text="Mob: 9701221934", score=0.98),
            Line(text="WhatsApp: 9701221935", score=0.98),
        ])
        self.assertEqual(got["whatsapp"], "+919701221935")

    def test_fax_is_not_a_phone(self):
        got = extract_phones([Line(text="Fax: 040 23456789", score=0.98)])
        self.assertEqual(got["mobiles"], [])
        self.assertEqual(got["landlines"], [])
        self.assertEqual(got["faxes"], ["+914023456789"])

    def test_pincode_is_not_a_phone(self):
        got = extract_phones([Line(text="Hyderabad 500082", score=0.98)])
        self.assertEqual(got["mobiles"], [])


class TestEmail(unittest.TestCase):
    def test_plain(self):
        got = extract_emails([Line(text="info@fristerfoods.com", score=0.98)])
        self.assertEqual(got, ["info@fristerfoods.com"])

    def test_spaces_around_at(self):
        got = extract_emails([Line(text="ravi.kumar @ gmail.com", score=0.9)])
        self.assertEqual(got, ["ravi.kumar@gmail.com"])

    def test_missing_dot_before_tld(self):
        self.assertEqual(fix_email_ocr("sales@chevellafarmscom"), "sales@chevellafarms.com")

    def test_gmail_misread(self):
        self.assertEqual(fix_email_ocr("ravi@gmaiI.com"), "ravi@gmail.com")

    def test_label_prefix_ignored(self):
        got = extract_emails([Line(text="Email: Sales@ChevellaFarms.com", score=0.95)])
        self.assertEqual(got, ["sales@chevellafarms.com"])


class TestClassifiers(unittest.TestCase):
    def test_person_names(self):
        for name in ["Ravi Kumar", "B. Sai Swaroop", "Mr. Anil Reddy", "PRIYA SHARMA"]:
            self.assertGreater(looks_like_person_name(name), 0.5, name)

    def test_non_names(self):
        for text in ["Frister Foods Pvt Ltd", "info@x.com", "9701221934",
                     "Managing Director", "701 Babu Khan Millennium Center",
                     "GSTIN: 36AABCU9603R1ZM", "www.chevellafarms.com"]:
            self.assertLess(looks_like_person_name(text), 0.5, text)

    def test_designations(self):
        for text in ["Managing Director", "Sr. Sales Manager", "Proprietor",
                     "Head - Procurement", "Asst. General Manager"]:
            self.assertGreaterEqual(designation_score(text), 0.45, text)

    def test_designation_not_a_name(self):
        self.assertEqual(designation_score("Ravi Kumar"), 0.0)

    def test_companies(self):
        for text in ["Frister Foods Pvt Ltd", "Sri Lakshmi Traders",
                     "Anand Agro Industries", "KRISHNA ENTERPRISES"]:
            self.assertGreaterEqual(company_score(text), 0.5, text)

    def test_address_lines(self):
        self.assertGreaterEqual(
            address_score("701 Babu Khan Millennium Center, Somajiguda, Hyderabad - 500082"), 0.5)

    def test_address_beats_company_on_industrial_estate(self):
        line = "Plot 42, Industrial Estate, Balanagar, Hyderabad 500037"
        self.assertGreater(address_score(line), company_score(line))


class TestNameFromEmail(unittest.TestCase):
    def test_dotted(self):
        self.assertEqual(name_from_email("ravi.kumar@gmail.com"), "Ravi Kumar")

    def test_generic_rejected(self):
        for e in ["info@x.com", "sales@x.com", "accounts@x.com", "md@x.com"]:
            self.assertIsNone(name_from_email(e), e)

    def test_trailing_digits_stripped(self):
        self.assertEqual(name_from_email("anilreddy99@gmail.com"), "Anilreddy")


class TestSplitAddress(unittest.TestCase):
    def test_hyderabad(self):
        got = split_address("701 Babu Khan Millennium Center, Somajiguda, Hyderabad - 500082, Telangana")
        self.assertEqual(got["pincode"], "500082")
        self.assertEqual(got["city"], "Hyderabad")
        self.assertEqual(got["state"], "Telangana")

    def test_unknown_city_from_pincode_neighbour(self):
        got = split_address("12 Main Road, Chevella, 501503, Telangana")
        self.assertEqual(got["pincode"], "501503")
        self.assertEqual(got["city"], "Chevella")

    def test_vizag_canonicalised(self):
        self.assertEqual(split_address("MVP Colony, Vizag 530017")["city"], "Visakhapatnam")

    def test_ap_not_matched_inside_apartments(self):
        got = split_address("Green Apartments, Kondapur, Hyderabad 500084")
        self.assertEqual(got.get("state"), "Telangana")


class TestWholeCards(unittest.TestCase):
    def test_typical_distributor_card(self):
        res = parse_card(blocks(
            ("SRI LAKSHMI TRADERS", 34),
            ("Ravi Kumar Reddy", 28),
            ("Managing Partner", 20),
            "Mobile: 98765 43210",
            "Ph: 040-23456789",
            "Email: ravi.kumar@srilakshmitraders.com",
            "www.srilakshmitraders.com",
            "12-3-456, Begum Bazaar, Hyderabad - 500012, Telangana",
            "GSTIN: 36AABCU9603R1ZM",
        ))
        f = res.fields
        self.assertEqual(f["full_name"], "Ravi Kumar Reddy")
        self.assertEqual(f["designation"], "Managing Partner")
        self.assertIn("Lakshmi", f["company"])
        self.assertEqual(f["phone_primary"], "+919876543210")
        self.assertEqual(f["phone_secondary"], "+914023456789")
        self.assertEqual(f["whatsapp"], "+919876543210")
        self.assertEqual(f["email"], "ravi.kumar@srilakshmitraders.com")
        self.assertEqual(f["website"], "https://srilakshmitraders.com")
        self.assertEqual(f["gstin"], "36AABCU9603R1ZM")
        self.assertEqual(f["city"], "Hyderabad")
        self.assertEqual(f["state"], "Telangana")
        self.assertEqual(f["pincode"], "500012")
        self.assertFalse(res.needs_review)

    def test_minimal_card_still_usable(self):
        res = parse_card(blocks(("Anil Reddy", 30), "9701221934"))
        self.assertEqual(res.fields["full_name"], "Anil Reddy")
        self.assertEqual(res.fields["phone_primary"], "+919701221934")

    def test_company_only_card_flags_review(self):
        res = parse_card(blocks(("KRISHNA AGRO FOODS", 34), "Hyderabad"))
        self.assertTrue(res.needs_review)
        self.assertIn("no_contact_channel_found", res.notes)

    def test_no_text_at_all(self):
        res = parse_card([])
        self.assertTrue(res.needs_review)
        self.assertIn("no_text_found", res.notes)

    def test_name_recovered_from_email_when_absent(self):
        res = parse_card(blocks(
            ("ANAND AGRO INDUSTRIES", 32),
            "priya.sharma@anandagro.in",
            "+91 98480 12345",
        ))
        self.assertEqual(res.fields["full_name"], "Priya Sharma")
        self.assertEqual(res.fields["phone_primary"], "+919848012345")

    def test_landline_only_card_has_no_whatsapp(self):
        res = parse_card(blocks(
            ("Hotel Sangeet", 30),
            ("Proprietor", 18),
            "Tel: 040 2345 6789",
            "bookings@hotelsangeet.in",
        ))
        self.assertEqual(res.fields["phone_primary"], "+914023456789")
        self.assertNotIn("whatsapp", res.fields)

    def test_company_never_duplicated_as_designation(self):
        res = parse_card(blocks(
            ("Global Food Marketing Pvt Ltd", 32),
            ("Suresh Babu", 26),
            "9701221934",
        ))
        self.assertNotEqual(res.fields.get("designation"), res.fields.get("company"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
