"""Turns raw OCR output into business-card fields.

This is where most of the real accuracy lives. An OCR engine gives you correct *characters*;
it has no idea which line is the person's name and which is the company. The strategy here
is to extract the unambiguous things first (email, phone, URL, GSTIN, pincode), use them as
evidence about everything else, and only then guess at the ambiguous things (name, company,
designation) — scoring each guess so the apps can flag weak ones for a human.

Every function is pure and dependency-free so it can be unit-tested without an OCR engine.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# --------------------------------------------------------------------------- vocabularies

DESIGNATION_WORDS = {
    "ceo", "cto", "cfo", "coo", "cmo", "md", "managing", "director", "chairman", "founder",
    "cofounder", "co-founder", "president", "vice", "vp", "avp", "svp", "gm", "agm", "dgm",
    "manager", "asst", "assistant", "deputy", "senior", "sr", "junior", "jr", "head",
    "lead", "incharge", "in-charge", "executive", "officer", "engineer", "consultant",
    "advisor", "analyst", "associate", "partner", "proprietor", "prop", "owner",
    "proprietress", "sales", "marketing", "purchase", "purchasing", "procurement",
    "business", "development", "bd", "bdm", "key", "account", "accounts", "finance",
    "operations", "ops", "logistics", "supply", "chain", "quality", "production",
    "plant", "factory", "store", "stores", "branch", "regional", "zonal", "territory",
    "area", "national", "export", "import", "admin", "administration", "hr", "recruiter",
    "chef", "buyer", "merchandiser", "distributor", "dealer", "agent", "representative",
    "rep", "technician", "supervisor", "coordinator", "specialist", "principal",
    "secretary", "treasurer", "trustee", "doctor", "dr", "professor", "prof",
}

# A line is treated as the company when it carries one of these.
COMPANY_MARKERS = [
    "pvt ltd", "pvt. ltd", "private limited", "pvt limited", "p ltd", "p. ltd",
    "limited", "ltd", "llp", "llc", "inc", "incorporated", "corporation", "corp",
    "company", "co.", "& co", "and co", "& sons", "and sons", "& brothers",
    "enterprises", "enterprise", "industries", "industry", "industrial",
    "traders", "trading", "trade", "agencies", "agency", "associates", "group",
    "exports", "export", "imports", "impex", "overseas", "international",
    "foods", "food", "beverages", "agro", "agri", "farms", "farm", "dairy",
    "mills", "mill", "products", "processors", "packaging", "packers",
    "distributors", "distribution", "marketing", "solutions", "services",
    "technologies", "systems", "labs", "laboratories", "pharma", "healthcare",
    "hotels", "hotel", "restaurant", "resorts", "retail", "stores", "supermarket",
    "hypermarket", "mart", "bazaar", "wholesale", "cash & carry", "catering",
]

ADDRESS_MARKERS = [
    "road", "rd", "street", "st", "lane", "ln", "cross", "main", "nagar", "colony",
    "layout", "sector", "block", "phase", "plot", "survey", "door", "flat", "floor",
    "building", "bldg", "tower", "complex", "centre", "center", "chambers", "house",
    "apartments", "apt", "industrial", "estate", "area", "park", "circle", "chowk",
    "market", "village", "post", "taluk", "mandal", "district", "dist", "tehsil",
    "near", "opp", "opposite", "behind", "beside", "above", "p.o", "po box", "pobox",
    "highway", "nh", "bypass", "gate", "no.", "h.no", "d.no", "shop", "unit", "ward",
]

INDIAN_STATES = {
    "andhra pradesh": "Andhra Pradesh", "ap": "Andhra Pradesh",
    "arunachal pradesh": "Arunachal Pradesh", "assam": "Assam", "bihar": "Bihar",
    "chhattisgarh": "Chhattisgarh", "chattisgarh": "Chhattisgarh", "goa": "Goa",
    "gujarat": "Gujarat", "haryana": "Haryana", "himachal pradesh": "Himachal Pradesh",
    "jharkhand": "Jharkhand", "karnataka": "Karnataka", "kerala": "Kerala",
    "madhya pradesh": "Madhya Pradesh", "mp": "Madhya Pradesh",
    "maharashtra": "Maharashtra", "manipur": "Manipur", "meghalaya": "Meghalaya",
    "mizoram": "Mizoram", "nagaland": "Nagaland", "odisha": "Odisha", "orissa": "Odisha",
    "punjab": "Punjab", "rajasthan": "Rajasthan", "sikkim": "Sikkim",
    "tamil nadu": "Tamil Nadu", "tamilnadu": "Tamil Nadu", "tn": "Tamil Nadu",
    "telangana": "Telangana", "ts": "Telangana", "tripura": "Tripura",
    "uttar pradesh": "Uttar Pradesh", "up": "Uttar Pradesh", "uttarakhand": "Uttarakhand",
    "west bengal": "West Bengal", "wb": "West Bengal",
    "delhi": "Delhi", "new delhi": "Delhi", "jammu": "Jammu & Kashmir",
    "kashmir": "Jammu & Kashmir", "ladakh": "Ladakh", "puducherry": "Puducherry",
    "pondicherry": "Puducherry", "chandigarh": "Chandigarh", "andaman": "Andaman & Nicobar",
    "dadra": "Dadra & Nagar Haveli and Daman & Diu", "lakshadweep": "Lakshadweep",
}

# Cities that matter for a South-India food expo, plus the metros, each mapped to its
# state. The mapping earns its keep twice: it recognises the city line, and it fills in
# the state on the very common card that prints "Hyderabad - 500084" and nothing else.
CITY_STATE = {
    # Telangana
    "hyderabad": "Telangana", "secunderabad": "Telangana", "warangal": "Telangana",
    "nizamabad": "Telangana", "karimnagar": "Telangana", "khammam": "Telangana",
    "chevella": "Telangana", "sangareddy": "Telangana", "medak": "Telangana",
    # Andhra Pradesh
    "vijayawada": "Andhra Pradesh", "visakhapatnam": "Andhra Pradesh",
    "vizag": "Andhra Pradesh", "guntur": "Andhra Pradesh", "tirupati": "Andhra Pradesh",
    "nellore": "Andhra Pradesh", "kakinada": "Andhra Pradesh",
    "rajahmundry": "Andhra Pradesh", "kurnool": "Andhra Pradesh",
    "anantapur": "Andhra Pradesh", "kadapa": "Andhra Pradesh", "ongole": "Andhra Pradesh",
    "eluru": "Andhra Pradesh", "chittoor": "Andhra Pradesh",
    # Karnataka
    "bengaluru": "Karnataka", "bangalore": "Karnataka", "mysuru": "Karnataka",
    "mysore": "Karnataka", "mangaluru": "Karnataka", "mangalore": "Karnataka",
    "hubli": "Karnataka", "belagavi": "Karnataka", "belgaum": "Karnataka",
    "davangere": "Karnataka", "shimoga": "Karnataka", "tumkur": "Karnataka",
    # Tamil Nadu
    "chennai": "Tamil Nadu", "coimbatore": "Tamil Nadu", "madurai": "Tamil Nadu",
    "tiruchirappalli": "Tamil Nadu", "trichy": "Tamil Nadu", "salem": "Tamil Nadu",
    "erode": "Tamil Nadu", "tirupur": "Tamil Nadu", "vellore": "Tamil Nadu",
    "thanjavur": "Tamil Nadu", "tirunelveli": "Tamil Nadu", "pollachi": "Tamil Nadu",
    "hosur": "Tamil Nadu", "kanchipuram": "Tamil Nadu",
    # Kerala
    "kochi": "Kerala", "cochin": "Kerala", "ernakulam": "Kerala",
    "thiruvananthapuram": "Kerala", "trivandrum": "Kerala", "kozhikode": "Kerala",
    "calicut": "Kerala", "thrissur": "Kerala", "kollam": "Kerala", "kannur": "Kerala",
    "palakkad": "Kerala", "alappuzha": "Kerala",
    # Maharashtra
    "mumbai": "Maharashtra", "navi mumbai": "Maharashtra", "thane": "Maharashtra",
    "pune": "Maharashtra", "nagpur": "Maharashtra", "nashik": "Maharashtra",
    "aurangabad": "Maharashtra", "kolhapur": "Maharashtra", "solapur": "Maharashtra",
    "ahmednagar": "Maharashtra",
    # North & west
    "delhi": "Delhi", "new delhi": "Delhi", "noida": "Uttar Pradesh",
    "gurugram": "Haryana", "gurgaon": "Haryana", "ghaziabad": "Uttar Pradesh",
    "faridabad": "Haryana", "ahmedabad": "Gujarat", "surat": "Gujarat",
    "vadodara": "Gujarat", "rajkot": "Gujarat", "gandhinagar": "Gujarat",
    "jaipur": "Rajasthan", "jodhpur": "Rajasthan", "udaipur": "Rajasthan",
    "kota": "Rajasthan", "lucknow": "Uttar Pradesh", "kanpur": "Uttar Pradesh",
    "varanasi": "Uttar Pradesh", "agra": "Uttar Pradesh", "prayagraj": "Uttar Pradesh",
    "allahabad": "Uttar Pradesh", "meerut": "Uttar Pradesh", "bhopal": "Madhya Pradesh",
    "indore": "Madhya Pradesh", "gwalior": "Madhya Pradesh", "jabalpur": "Madhya Pradesh",
    "chandigarh": "Chandigarh", "ludhiana": "Punjab", "amritsar": "Punjab",
    "jalandhar": "Punjab", "dehradun": "Uttarakhand", "shimla": "Himachal Pradesh",
    # East & north-east
    "kolkata": "West Bengal", "howrah": "West Bengal", "siliguri": "West Bengal",
    "durgapur": "West Bengal", "asansol": "West Bengal", "patna": "Bihar",
    "ranchi": "Jharkhand", "jamshedpur": "Jharkhand", "bhubaneswar": "Odisha",
    "cuttack": "Odisha", "rourkela": "Odisha", "guwahati": "Assam",
    "shillong": "Meghalaya", "imphal": "Manipur", "agartala": "Tripura",
    "raipur": "Chhattisgarh", "bhilai": "Chhattisgarh",
    # Goa
    "panaji": "Goa", "vasco": "Goa", "margao": "Goa",
}

KNOWN_CITIES = set(CITY_STATE)

# Old names and local short forms normalised to one spelling, so the Excel export groups
# "Vizag" and "Visakhapatnam" into the same city instead of two.
CITY_CANONICAL = {
    "vizag": "Visakhapatnam", "bangalore": "Bengaluru", "mysore": "Mysuru",
    "mangalore": "Mangaluru", "belgaum": "Belagavi", "trichy": "Tiruchirappalli",
    "cochin": "Kochi", "calicut": "Kozhikode", "trivandrum": "Thiruvananthapuram",
    "gurgaon": "Gurugram", "allahabad": "Prayagraj", "new delhi": "New Delhi",
    "navi mumbai": "Navi Mumbai",
}

HONORIFICS = {"mr", "mrs", "ms", "dr", "prof", "shri", "sri", "smt", "er", "ca", "adv", "capt"}

NAME_NOISE = {
    "gst", "gstin", "pan", "tin", "cin", "fssai", "iso", "msme", "udyam", "email", "mail",
    "phone", "mobile", "mob", "cell", "tel", "telephone", "fax", "web", "website", "www",
    "address", "office", "branch", "factory", "works", "showroom", "contact", "india",
}

# --------------------------------------------------------------------------- regexes

RE_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
RE_URL = re.compile(
    r"\b(?:https?://)?(?:www\.)?"
    r"((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+"
    r"(?:com|in|net|org|co|io|biz|info|shop|store|farm|food|co\.in|net\.in|org\.in|gov\.in|edu|ai|app|online|site))"
    r"(/[^\s,;]*)?",
    re.I,
)
RE_GSTIN = re.compile(r"\b(\d{2}[A-Z]{5}\d{4}[A-Z][\dA-Z]Z[\dA-Z])\b")
RE_PAN = re.compile(r"\b([A-Z]{5}\d{4}[A-Z])\b")
RE_FSSAI = re.compile(r"\b(\d{14})\b")
RE_PINCODE = re.compile(r"\b([1-9]\d{5})\b")

# A phone-looking run: 8+ digits possibly broken by spaces, dots, hyphens, slashes, brackets.
RE_PHONE_RUN = re.compile(r"(?:(?:\+|00)\s?\d{1,3}[\s\-.]?)?(?:\(?\d{2,5}\)?[\s\-./]?){2,6}\d{2,5}")

PHONE_LABELS = {
    "mobile": ("mobile", "mob", "cell", "m:", "m -", "cel"),
    "phone": ("phone", "ph", "tel", "telephone", "t:", "o:", "off"),
    "whatsapp": ("whatsapp", "wa", "w/a", "watsapp", "whats app"),
    "fax": ("fax", "f:"),
}

# --------------------------------------------------------------------------- data types


@dataclass
class Line:
    """One OCR text line plus the geometry we reason about."""

    text: str
    score: float
    x: float = 0.0
    y: float = 0.0
    w: float = 0.0
    h: float = 0.0
    index: int = 0

    @property
    def lower(self) -> str:
        return self.text.lower()


@dataclass
class ParseResult:
    fields: dict = field(default_factory=dict)
    confidence: dict = field(default_factory=dict)
    needs_review: bool = True
    notes: list = field(default_factory=list)


# --------------------------------------------------------------------------- text cleanup


def normalise_text(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace("’", "'").replace("‘", "'")
    s = re.sub(r"[‐-―−]", "-", s)   # unicode dashes
    s = re.sub(r"[  -​]", " ", s)   # exotic spaces
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip(" \t|·•–-—:;,")


def fix_email_ocr(s: str) -> str:
    """Repairs the handful of substitutions OCR reliably makes inside an address."""
    s = s.strip().strip(".,;:|")
    s = re.sub(r"\s+", "", s)
    s = s.replace("(at)", "@").replace("[at]", "@").replace(" at ", "@")
    s = re.sub(r"(?<=@)[Oo](?=[a-z])", "o", s)
    # A missing dot before a TLD is the most common break.
    s = re.sub(r"@([A-Za-z0-9\-]+)(com|in|net|org)$", r"@\1.\2", s)
    s = s.replace("@gmaiI.com", "@gmail.com").replace("@gmai1.com", "@gmail.com")
    s = re.sub(r"@gmail?\.co$", "@gmail.com", s)
    return s.lower()


def _digits_only(s: str) -> str:
    return re.sub(r"\D", "", s)


def to_e164(raw: str, default_cc: str = "91") -> str | None:
    """Mirrors cf-api/src/lib/phone.js so both sides agree on what a number looks like."""
    if not raw:
        return None
    s = str(raw).strip()
    has_plus = s.startswith("+") or bool(re.match(r"^00\d", s))
    # Letter/digit confusions only inside digit runs.
    s = re.sub(r"(?<=\d)[oO](?=\d)|(?<=\d)[oO]$|^[oO](?=\d)", "0", s)
    s = re.sub(r"(?<=\d)[lI](?=\d)", "1", s)
    d = _digits_only(s)
    d = re.sub(r"^00", "", d)
    if not d:
        return None

    if has_plus:
        return f"+{d}" if 8 <= len(d) <= 15 else None

    if len(d) == 11 and d.startswith("0"):
        d = d[1:]
    if len(d) == 12 and d.startswith(default_cc):
        return f"+{d}"
    if len(d) == 13 and d.startswith("0" + default_cc):
        return f"+{d[1:]}"
    if len(d) == 10:
        return f"+{default_cc}{d}"
    if 8 <= len(d) <= 15:
        return f"+{default_cc}{d}"
    return None


def is_indian_mobile(e164: str | None) -> bool:
    return bool(e164 and re.match(r"^\+91[6-9]\d{9}$", e164))


# --------------------------------------------------------------------------- extractors


def extract_emails(lines: list[Line]) -> list[str]:
    found: list[str] = []
    for ln in lines:
        candidate = ln.text
        # OCR sometimes drops the space around '@'; also try a de-spaced copy.
        for probe in (candidate, re.sub(r"\s*@\s*", "@", candidate)):
            for m in RE_EMAIL.finditer(probe):
                e = fix_email_ocr(m.group(0))
                if "@" in e and "." in e.split("@", 1)[1] and e not in found:
                    found.append(e)
    return found


def extract_urls(lines: list[Line]) -> list[str]:
    """Websites only.

    The tricky part is that an email address contains a perfectly valid-looking domain, and
    a card usually prints both on the same line ("info@acme.in · www.acme.in"). Matching
    the email first and blanking it out is what keeps the two apart — a domain filter
    cannot, because the website and the email legitimately share a host most of the time.
    """
    found: list[str] = []
    for ln in lines:
        text = ln.text
        if text.lower().lstrip().startswith(("www", "web", "site", "url")):
            text = re.sub(r"\s+", "", text)
        # Remove every email address before looking for URLs.
        text = RE_EMAIL.sub(" ", re.sub(r"\s*@\s*", "@", text))
        text = re.sub(r"\S+@\S+", " ", text)

        for m in RE_URL.finditer(text):
            domain = m.group(1).lower().rstrip(".")
            path = (m.group(2) or "").rstrip(".,;")
            if "@" in m.group(0):
                continue
            # A lone two-label domain with no www and no path is more often a typo'd
            # email remnant than a website; require some positive signal.
            looks_intentional = (
                "www." in m.group(0).lower()
                or m.group(0).lower().startswith("http")
                or bool(path)
                or domain.count(".") >= 2
            )
            if not looks_intentional and not re.search(r"(?i)\b(web|site|url|visit)\b", ln.text):
                continue
            url = f"https://{domain}{path}"
            if url not in found:
                found.append(url)
    return found


def extract_phones(lines: list[Line]) -> dict:
    """Returns {'mobiles': [...], 'landlines': [...], 'whatsapp': str|None, 'fax': [...]}"""
    mobiles: list[str] = []
    landlines: list[str] = []
    faxes: list[str] = []
    whatsapp: str | None = None

    for ln in lines:
        low = ln.lower
        # Which label, if any, governs this line?
        label = None
        for kind, keys in PHONE_LABELS.items():
            if any(k in low for k in keys):
                label = kind
                break

        # Strip the label words so they cannot be read as digits.
        body = re.sub(r"(?i)\b(mobile|mob|cell|phone|ph|tel|telephone|fax|whatsapp|wa|off|office|resi)\b\.?:?", " ", ln.text)

        for m in RE_PHONE_RUN.finditer(body):
            raw = m.group(0)
            d = _digits_only(raw)
            if len(d) < 8:
                continue
            # A pincode or a GSTIN fragment is not a phone number.
            if len(d) == 6 and RE_PINCODE.fullmatch(d):
                continue
            # Two numbers written "9701221934 / 9701221935" split on the slash already,
            # but "97012219349701221935" needs splitting by length.
            chunks = _split_number_run(d)
            for chunk in chunks:
                e164 = to_e164(chunk)
                if not e164:
                    continue
                if label == "fax":
                    if e164 not in faxes:
                        faxes.append(e164)
                    continue
                if is_indian_mobile(e164):
                    if e164 not in mobiles:
                        mobiles.append(e164)
                    if label == "whatsapp" and whatsapp is None:
                        whatsapp = e164
                else:
                    if e164 not in landlines:
                        landlines.append(e164)

    return {"mobiles": mobiles, "landlines": landlines, "whatsapp": whatsapp, "faxes": faxes}


def _split_number_run(d: str) -> list[str]:
    """'97012219349701221935' -> two 10-digit numbers. Leaves anything else alone."""
    if len(d) in (20, 24, 30) and len(d) % 10 == 0:
        return [d[i:i + 10] for i in range(0, len(d), 10)]
    if len(d) == 22 and d.startswith("91"):
        return [d[:12], d[12:]]
    return [d]


def extract_ids(text: str) -> dict:
    up = text.upper()
    out: dict = {}
    g = RE_GSTIN.search(up.replace(" ", ""))
    if g:
        out["gstin"] = g.group(1)
        # The PAN is embedded in a GSTIN; derive it instead of matching loose 10-char runs.
        out["pan"] = g.group(1)[2:12]
    else:
        p = RE_PAN.search(up.replace(" ", ""))
        if p:
            out["pan"] = p.group(1)
    if "FSSAI" in up or "LIC. NO" in up or "LIC NO" in up:
        f = RE_FSSAI.search(up)
        if f:
            out["fssai"] = f.group(1)
    return out


# --------------------------------------------------------------------------- classifiers


def looks_like_person_name(text: str) -> float:
    """0..1 — how much this line reads like a human name rather than anything else."""
    t = normalise_text(text)
    if not t or any(ch.isdigit() for ch in t):
        return 0.0
    if "@" in t or "www" in t.lower() or "/" in t:
        return 0.0

    words = [w for w in re.split(r"[\s.]+", t) if w]
    if not (1 <= len(words) <= 5):
        return 0.0

    low = t.lower()
    if any(w.strip(".,") in NAME_NOISE for w in low.split()):
        return 0.0
    if any(marker in low for marker in COMPANY_MARKERS):
        return 0.0
    if any(marker in low.split() for marker in ADDRESS_MARKERS):
        return 0.0

    core = [w for w in words if w.lower().strip(".") not in HONORIFICS]
    if not core or len(core) > 4:
        return 0.0

    score = 0.45
    # Title Case is the single strongest signal.
    if all(re.match(r"^[A-Z][a-z'\-]+$", w) for w in core):
        score += 0.35
    elif all(w.isupper() for w in core) and len(core) <= 3:
        score += 0.18   # ALL-CAPS names are common on Indian cards
    elif sum(1 for w in core if w[:1].isupper()) >= len(core) - 1:
        score += 0.12

    if len(words) != len(core):
        score += 0.15   # an honorific was present
    if 2 <= len(core) <= 3:
        score += 0.08
    if any(len(w) <= 2 and w.isupper() for w in core):
        score += 0.04   # initials, e.g. "B. Sai Swaroop"

    designation_hits = sum(1 for w in low.replace(".", " ").split() if w in DESIGNATION_WORDS)
    score -= 0.3 * designation_hits

    return max(0.0, min(1.0, score))


def designation_score(text: str) -> float:
    words = [w.strip(".,&-") for w in normalise_text(text).lower().replace("/", " ").split()]
    if not words:
        return 0.0
    hits = sum(1 for w in words if w in DESIGNATION_WORDS)
    if hits == 0:
        return 0.0
    ratio = hits / len(words)
    score = min(1.0, 0.4 + ratio * 0.7)
    if any(ch.isdigit() for ch in text):
        score -= 0.35
    if len(words) > 7:
        score -= 0.2
    return max(0.0, score)


def company_score(text: str) -> float:
    low = normalise_text(text).lower()
    if not low or "@" in low:
        return 0.0
    hits = [m for m in COMPANY_MARKERS if m in low]
    if not hits:
        return 0.0
    score = 0.55 + 0.1 * min(3, len(hits))
    # Strong legal forms are near-certain.
    if any(m in low for m in ("pvt ltd", "pvt. ltd", "private limited", "llp", "limited", "inc")):
        score += 0.25
    if RE_PINCODE.search(low):
        score -= 0.35   # it is the address line that happens to mention "industrial estate"
    if sum(1 for m in ADDRESS_MARKERS if m in low.split()) >= 2:
        score -= 0.3
    return max(0.0, min(1.0, score))


def address_score(text: str) -> float:
    low = normalise_text(text).lower()
    if not low or "@" in low:
        return 0.0
    score = 0.0
    if RE_PINCODE.search(low):
        score += 0.5
    tokens = re.split(r"[\s,.\-/]+", low)
    hits = sum(1 for t in tokens if t in ADDRESS_MARKERS)
    score += min(0.45, hits * 0.18)
    if any(c in low for c in KNOWN_CITIES):
        score += 0.2
    if any(s in low for s in INDIAN_STATES):
        score += 0.15
    if any(ch.isdigit() for ch in low) and hits:
        score += 0.1
    return min(1.0, score)


def name_from_email(email: str) -> str | None:
    """'ravi.kumar@…' -> 'Ravi Kumar'. Only when the local part really looks like a name."""
    local = email.split("@", 1)[0]
    local = re.sub(r"\d+$", "", local)
    parts = [p for p in re.split(r"[._\-]+", local) if p]
    if not parts or len(parts) > 3:
        return None
    if any(len(p) < 2 for p in parts) and len(parts) > 1:
        return None
    generic = {"info", "sales", "contact", "admin", "office", "support", "enquiry",
               "enquiries", "mail", "hello", "care", "marketing", "accounts", "export",
               "purchase", "orders", "team", "hr", "ceo", "md"}
    if any(p.lower() in generic for p in parts):
        return None
    if len(parts) == 1 and len(parts[0]) < 5:
        return None
    return " ".join(p.capitalize() for p in parts)


def split_address(address: str) -> dict:
    """Pulls city / state / pincode out of a joined address string."""
    out: dict = {}
    if not address:
        return out

    pin = RE_PINCODE.search(address)
    if pin:
        out["pincode"] = pin.group(1)

    low = address.lower()

    # Longest match first, so "navi mumbai" beats "mumbai" and "new delhi" beats "delhi".
    city_key = None
    for city in sorted(KNOWN_CITIES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(city)}\b", low):
            city_key = city
            break

    if city_key:
        out["city"] = CITY_CANONICAL.get(city_key, city_key.title())
    elif pin:
        # No city we recognise: take the comma-separated token just before the pincode.
        before = address[: pin.start()].rstrip(" ,-")
        tail = re.split(r"[,\-]", before)[-1].strip()
        if tail and 2 < len(tail) <= 28 and not any(ch.isdigit() for ch in tail):
            out["city"] = tail.title()

    # An explicitly printed state always wins over the one inferred from the city.
    # The \b guard stops "ap" matching inside "apartments".
    for key, proper in sorted(INDIAN_STATES.items(), key=lambda kv: -len(kv[0])):
        if re.search(rf"\b{re.escape(key)}\b", low):
            out["state"] = proper
            break
    else:
        if city_key:
            out["state"] = CITY_STATE[city_key]

    return out


# --------------------------------------------------------------------------- main entry


def parse_card(blocks: list[dict]) -> ParseResult:
    """blocks: [{'text':…, 'score':…, 'box':[[x,y]…]}] in reading order-ish."""
    lines = _to_lines(blocks)
    if not lines:
        return ParseResult(fields={}, confidence={}, needs_review=True, notes=["no_text_found"])

    full_text = "\n".join(ln.text for ln in lines)

    emails = extract_emails(lines)
    urls = extract_urls(lines)
    phones = extract_phones(lines)
    ids = extract_ids(full_text)

    fields: dict = {}
    conf: dict = {}
    notes: list[str] = []

    # --- the certain things -------------------------------------------------
    if emails:
        fields["email"] = emails[0]
        conf["email"] = 0.97
        if len(emails) > 1:
            fields["email_secondary"] = emails[1]
            conf["email_secondary"] = 0.9
    if urls:
        fields["website"] = urls[0]
        conf["website"] = 0.93
    if ids.get("gstin"):
        fields["gstin"] = ids["gstin"]
        conf["gstin"] = 0.98

    mobiles, landlines = phones["mobiles"], phones["landlines"]
    ordered = mobiles + landlines
    if ordered:
        fields["phone_primary"] = ordered[0]
        conf["phone_primary"] = 0.95 if mobiles else 0.85
    if len(ordered) > 1:
        fields["phone_secondary"] = ordered[1]
        conf["phone_secondary"] = 0.88
    # WhatsApp: an explicit label wins, else the first mobile (a landline never works).
    if phones["whatsapp"]:
        fields["whatsapp"] = phones["whatsapp"]
        conf["whatsapp"] = 0.95
    elif mobiles:
        fields["whatsapp"] = mobiles[0]
        conf["whatsapp"] = 0.72
        notes.append("whatsapp_assumed_from_mobile")

    # --- company -----------------------------------------------------------
    company_ln, company_conf, company_note = _pick_company(lines, emails, urls)
    if company_ln is not None:
        fields["company"] = _tidy_company(company_ln.text)
        conf["company"] = round(company_conf, 3)
        if company_note:
            notes.append(company_note)
    else:
        base = _domain_base(emails, urls)
        if base:
            fields["company"] = base.replace("-", " ").title()
            conf["company"] = 0.45
            notes.append("company_from_domain")

    # --- designation -------------------------------------------------------
    desig_ranked = sorted(((designation_score(ln.text), ln) for ln in lines),
                          key=lambda t: t[0], reverse=True)
    if desig_ranked and desig_ranked[0][0] >= 0.45:
        s, ln = desig_ranked[0]
        # Never let the company line double as the designation.
        if _tidy_company(ln.text) != fields.get("company"):
            fields["designation"] = normalise_text(ln.text).title() if ln.text.isupper() else normalise_text(ln.text)
            conf["designation"] = round(min(0.93, s * ln.score), 3)

    # --- name --------------------------------------------------------------
    name_ln, name_conf = _pick_name(lines, fields, emails)
    if name_ln:
        fields["full_name"] = _tidy_name(name_ln.text)
        conf["full_name"] = round(name_conf, 3)
    elif emails:
        guess = name_from_email(emails[0])
        if guess:
            fields["full_name"] = guess
            conf["full_name"] = 0.5
            notes.append("name_from_email")

    # --- address -----------------------------------------------------------
    addr_lines = [ln for ln in lines if address_score(ln.text) >= 0.35]
    if addr_lines:
        addr_lines.sort(key=lambda ln: ln.index)
        joined = ", ".join(normalise_text(ln.text).strip(" ,") for ln in addr_lines)
        joined = re.sub(r",\s*,", ", ", joined)
        fields["address"] = joined
        conf["address"] = round(min(0.9, 0.55 + 0.1 * len(addr_lines)), 3)
        fields.update(split_address(joined))
        for k in ("city", "state", "pincode"):
            if k in fields:
                conf[k] = 0.85 if k == "pincode" else 0.75

    # --- review decision ---------------------------------------------------
    # The bar: a lead is only useful if you can reach the person. No phone and no email
    # means a human must look at the photo, whatever the OCR confidence was.
    reachable = bool(fields.get("phone_primary") or fields.get("email"))
    strong = all(conf.get(k, 0) >= 0.7 for k in ("full_name", "company") if k in fields)
    has_identity = bool(fields.get("full_name") or fields.get("company"))

    needs_review = not (reachable and has_identity and strong)
    if not reachable:
        notes.append("no_contact_channel_found")
    if not has_identity:
        notes.append("no_name_or_company_found")

    return ParseResult(fields=fields, confidence=conf, needs_review=needs_review, notes=notes)


# --------------------------------------------------------------------------- helpers


def _to_lines(blocks: list[dict]) -> list[Line]:
    out: list[Line] = []
    for i, b in enumerate(blocks or []):
        text = normalise_text(b.get("text", ""))
        if not text:
            continue
        box = b.get("box") or []
        x = y = w = h = 0.0
        if box:
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x, y = min(xs), min(ys)
            w, h = max(xs) - x, max(ys) - y
        out.append(Line(text=text, score=float(b.get("score", 0.9)),
                        x=x, y=y, w=w, h=h, index=i))
    out.sort(key=lambda ln: (round(ln.y / 12), ln.x))
    for i, ln in enumerate(out):
        ln.index = i
    return out


FREE_MAIL_HOSTS = {
    "gmail", "yahoo", "hotmail", "outlook", "rediffmail", "live", "icloud",
    "ymail", "protonmail", "aol", "msn", "zoho", "me", "mail",
}

# Words that describe what a business *does*. A line built mostly out of these is the
# tagline under the logo, not the registered name.
DESCRIPTOR_WORDS = {
    "wholesale", "retail", "authorised", "authorized", "approved", "certified",
    "leading", "reputed", "quality", "best", "genuine", "specialist", "specialists",
    "dealing", "dealers", "suppliers", "stockist", "stockists", "manufacturers",
    "exporters", "importers", "wholesalers", "distributors", "distributor",
    "all", "kinds", "types", "of", "in", "and", "for", "we", "deal",
}


def _domain_base(emails: list[str], urls: list[str]) -> str | None:
    """'ravi@srilakshmitraders.com' -> 'srilakshmitraders'. None for free mail hosts."""
    host = None
    if urls:
        host = urls[0].split("//", 1)[-1].split("/")[0]
    elif emails:
        host = emails[0].split("@", 1)[1]
    if not host:
        return None
    base = host.lower().removeprefix("www.").split(".")[0]
    return None if base in FREE_MAIL_HOSTS else base


def _letters(s: str) -> str:
    return re.sub(r"[^a-z]", "", (s or "").lower())


def _pick_company(lines, emails, urls):
    """Chooses the company line, combining four independent pieces of evidence.

    The marker vocabulary alone is not enough: "Wholesale Foods & Beverages Distributor"
    hits more markers than "SRI LAKSHMI TRADERS" and would win, even though it is the
    tagline. Three things break that tie reliably on real cards —

      * the domain, which on Indian B2B cards is almost always the company name with the
        spaces removed, so letters-only equality is near-proof;
      * font size, because the registered name is the largest thing on the card;
      * word count and descriptor density, because taglines are long and generic.
    """
    if not lines:
        return None, 0.0, None

    base = _domain_base(emails, urls)
    heights = [ln.h for ln in lines if ln.h > 0]
    max_h = max(heights) if heights else 1.0
    max_y = max((ln.y + ln.h) for ln in lines) or 1.0

    best = None
    for ln in lines:
        marker = company_score(ln.text)
        letters = _letters(ln.text)

        domain_match = 0.0
        if base and letters:
            if letters == base:
                domain_match = 1.0                       # exact: effectively certain
            elif base.startswith(letters) and len(letters) >= 6:
                domain_match = 0.75                      # card drops "Pvt Ltd", domain keeps it
            elif letters.startswith(base) and len(base) >= 6:
                domain_match = 0.7

        if marker == 0.0 and domain_match == 0.0:
            continue
        if looks_like_person_name(ln.text) >= 0.6 and domain_match == 0.0:
            continue
        if address_score(ln.text) >= 0.5:
            continue

        words = [w for w in re.split(r"[\s&.,/-]+", ln.lower) if w]
        descriptors = sum(1 for w in words if w in DESCRIPTOR_WORDS)
        tagline_penalty = 0.0
        if words:
            if descriptors / len(words) >= 0.4 and len(words) >= 3:
                tagline_penalty += 0.3
            if len(words) >= 5:
                tagline_penalty += 0.15

        total = (
            0.42 * marker
            + 0.30 * domain_match
            + 0.20 * (ln.h / max_h if max_h else 0)
            + 0.08 * (1.0 - min(1.0, ln.y / max_y))
            - tagline_penalty
        )
        total *= 0.7 + 0.3 * ln.score

        if best is None or total > best[0]:
            best = (total, ln, domain_match)

    if not best or best[0] < 0.3:
        return None, 0.0, None

    total, ln, domain_match = best
    note = "company_confirmed_by_domain" if domain_match >= 0.7 else None
    # The domain agreeing is worth far more than the heuristics; say so in the confidence.
    confidence = min(0.97, 0.9 if domain_match >= 1.0 else min(0.88, 0.45 + total))
    return ln, confidence, note


def _largest_top_line(lines: list[Line]) -> Line | None:
    if not lines:
        return None
    max_y = max((ln.y + ln.h) for ln in lines) or 1
    upper = [ln for ln in lines
             if ln.y < max_y * 0.55
             and looks_like_person_name(ln.text) < 0.5
             and address_score(ln.text) < 0.35
             and "@" not in ln.text
             and not any(ch.isdigit() for ch in ln.text)]
    if not upper:
        return None
    return max(upper, key=lambda ln: (ln.h, len(ln.text)))


def _pick_name(lines: list[Line], fields: dict, emails: list[str]) -> tuple[Line | None, float]:
    """Combines the name-shape score with font size, position and the email's local part."""
    email_hint = name_from_email(emails[0]) if emails else None
    hint_tokens = {t.lower() for t in (email_hint or "").split()}
    heights = [ln.h for ln in lines if ln.h > 0]
    max_h = max(heights) if heights else 1.0
    max_y = max((ln.y + ln.h) for ln in lines) or 1.0
    company = (fields.get("company") or "").lower()

    best: tuple[float, Line] | None = None
    for ln in lines:
        shape = looks_like_person_name(ln.text)
        if shape < 0.4:
            continue
        if company and normalise_text(ln.text).lower() == company:
            continue

        total = shape * 0.62
        if max_h:
            total += 0.18 * min(1.0, ln.h / max_h)        # names are usually set large
        total += 0.10 * (1.0 - min(1.0, ln.y / max_y))    # and usually near the top
        if hint_tokens and hint_tokens & {t.lower() for t in ln.text.split()}:
            total += 0.22                                  # the email agrees
        total *= 0.6 + 0.4 * ln.score                      # weight by OCR certainty

        if best is None or total > best[0]:
            best = (total, ln)

    if not best:
        return None, 0.0
    return best[1], min(0.96, best[0])


def _tidy_name(text: str) -> str:
    t = normalise_text(text)
    t = re.sub(r"^(mr|mrs|ms|dr|prof|shri|sri|smt|er|ca|adv|capt)\.?\s+", "", t, flags=re.I)
    if t.isupper() and len(t) > 3:
        t = " ".join(w.capitalize() if len(w) > 2 else w for w in t.split())
    return t.strip()


def _tidy_company(text: str) -> str:
    t = normalise_text(text)
    if t.isupper() and len(t) > 4:
        # Keep short all-caps tokens (PVT, LTD, LLP, GST) as-is; title-case real words.
        keep = {"PVT", "LTD", "LLP", "LLC", "INC", "CO", "AND", "OF", "THE", "INDIA"}
        t = " ".join(w if w in keep or len(w) <= 3 else w.capitalize() for w in t.split())
    t = re.sub(r"\bPvt\b\.?\s*\bLtd\b\.?", "Pvt Ltd", t, flags=re.I)
    return t.strip(" .,-")
