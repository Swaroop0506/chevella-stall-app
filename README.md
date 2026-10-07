# Chevella Farms — Stall App

Two jobs, one system, built for a stall at a trade expo:

1. **Get our contact into the visitor's phone.** Every person on the stall gets their own QR
   code. A visitor scans it and lands on a Chevella-branded page with one big button —
   *Save our contact* — and a *WhatsApp us* button beside it. Two taps and you are in their
   phone book. There is also a QR for the website.
2. **Get their visiting card into our database.** Staff photograph cards — either from a
   **web link** that needs nothing installed, or from the **Android app**. No login either
   way. The photo and the text read off it land in the admin console, and the whole lot
   exports to Excel.

Everything runs on your own server. No subscriptions, no per-scan fees, no third-party OCR
API — the text recognition runs locally on CPU.

---

## What's in the box

| Service | What it is | Stack |
|---|---|---|
| `cf-api` | REST API, QR + vCard + PDF generation, Excel export | Node 22, Express, Postgres 17 |
| `cf-admin` | Admin console, the public `/c/<code>` contact pages, **and** the `/scan` web scanner | Next.js 15 (App Router) |
| `cf-ocr` | Visiting-card OCR and field extraction | Python 3.12, FastAPI, PP-OCRv5 via ONNX |
| `cf-mobile` | The Android scanner app | Expo SDK 53, React Native 0.79 |

```
visitor's phone ──scan QR──▶ cf-admin /c/<code> ──▶ vCard download + WhatsApp deep link
                                   │
staff phone ──photo──▶ cf-api ──▶ cf-ocr ──▶ fields ──▶ Postgres ──▶ Excel
  /scan or the APK       │
                         └─ card photos on a local volume
```

---

## Running it

```bash
cp .env.example .env          # fill in the secrets and PUBLIC_BASE_URL
docker compose up -d --build
docker compose exec api npm run migrate
```

Then open `http://localhost:3000` and sign in with the `SEED_ADMIN_*` credentials from
`.env`. The first `migrate` creates that admin; afterwards, blank out
`SEED_ADMIN_PASSWORD`.

Generate the two secrets with `openssl rand -hex 32`.

> **`PUBLIC_BASE_URL` is the one setting you must get right before printing anything.**
> It is baked into every contact QR code. If you print QRs pointing at `localhost`,
> every one of them is waste paper. Set it to the real `https://` address first.

See [DEPLOYMENT.md](DEPLOYMENT.md) for putting this on a server with HTTPS.

### Local development without Docker

```bash
# Postgres on :5432, then:
cd cf-api   && npm install && npm run migrate && npm run dev     # :4000
cd cf-admin && npm install && npm run dev                        # :3000
cd cf-ocr   && pip install -r requirements.txt && uvicorn src.main:app --port 8000
```

`cf-admin` proxies `/api/v1/*` to `cf-api`, so the browser only ever talks to one origin
and the session cookie stays same-origin. Point it with `API_INTERNAL_URL` in
`cf-admin/.env.local`.

---

## Running an event

1. **Events & QRs → New event.** Set the status to *Active* on the morning of the show —
   only active and upcoming events appear in the scanner app.
2. **Add a contact for each person on the stall.** Name, designation, phone. A QR code is
   generated immediately. The WhatsApp opening message is pre-written and editable.
3. **Download the print pack.** Posters (one A4 per person, QR at ~9 cm — scans from a
   metre away) or table tents (four per A4 with cut guides). The pack always opens with
   the website QR for the backdrop.
4. **Set up the stall phones** from the *Scanner* page. Quickest route: WhatsApp everyone
   the web link, they tap it, type their name and pick the event. For the phones that will
   be on the stall all day, install the APK instead — it keeps uploading after it is
   closed.
5. **During the show**, staff tap *Scan a visiting card*, frame it, tap *Keep & next*. That
   is the whole interaction — about three seconds per card. Add interest tags and a note
   when there is a lull.
6. **Afterwards**, work through *Leads → Needs review*, then **Export to Excel**.

### Two kinds of contact QR

The admin offers both per contact:

- **Page QR** (the default) points at `/c/<code>`. It gets you the Save button *and* the
  WhatsApp button, plus scan analytics — you can see which person's QR actually got used.
  It needs the server to be reachable.
- **Direct vCard QR** encodes the contact into the code itself. It works with no internet
  at all, but there is no WhatsApp button and no analytics. It is offered only when the
  contact is small enough to still scan reliably.

Use the page QR unless the venue has genuinely no connectivity.

---

## Two ways to scan a card

Both feed the same lead list. Mix them across phones freely — the only difference is how
long a phone keeps uploading after the person stops looking at it.

| | **Web link** (`/scan`) | **Android app** |
|---|---|---|
| Install | nothing | sideload an APK |
| Works on | any modern phone, incl. iPhone | Android only |
| Offline capture | yes (IndexedDB) | yes |
| Uploads after you close it | **no** — tab must stay open | yes |
| Best for | ad-hoc helpers, borrowed phones, iPhones | the phones on the stall all three days |

### The web link

**Scanner** in the admin gives you a link and a QR. The link carries the device key in its
`#fragment`, so staff tap it once and land already connected — all they type is their name.

Why a fragment and not `?k=`: a fragment is never sent to the server, so the key stays out
of access logs and `Referer` headers. The page consumes it on load and immediately strips
it from the address bar. It does still sit in the WhatsApp message you sent and in browser
history — so if you would rather it did not, send the bare `https://…/scan` link and read
the device key out separately; the setup screen accepts it pasted.

Tell staff to **Add to Home screen**. It then opens full screen with no address bar, and
the service worker keeps it loading with no signal.

**The one real limitation:** a browser only uploads while its tab is open. The scanner
shows a **Waiting** counter and warns before you close the tab with cards outstanding, but
a phone that is locked in a pocket is not uploading. For phones that will run all day,
install the APK.

**Camera access needs HTTPS.** Over plain `http://` (other than `localhost`) browsers block
`getUserMedia` outright, and the admin page says so in red. The *Use my phone camera app
instead* button still works in that case — it goes through the OS camera, which also
produces a better photo, just with two extra taps.

---

## About the OCR

**The honest version: this is not 100% accurate, and no OCR is.** What it is, is the best
free option, tuned for this specific job, with the cases it gets wrong flagged rather than
hidden.

The engine is **PP-OCRv5** (Baidu's current PaddleOCR models) served through RapidOCR's
ONNX Runtime build — the strongest freely-licensed OCR for dense, small, mixed-case Latin
text on cluttered backgrounds, which is exactly what a business card is. It runs on CPU,
needs no API key, and costs nothing per scan.

Four things lift real-world accuracy well above a naive `engine(image)` call:

1. **Model choice was measured, not assumed.** RapidOCR's default is PP-OCRv4, which does
   not emit spaces in Latin text — `SRI LAKSHMI TRADERS` comes back as `SRILAKSHMITRADERS`,
   which destroys every name and company heuristic. PP-OCRv5 recovered 16 of 19 spaces on
   the benchmark card against v4's 2, and is faster. The higher-capacity *server* models
   were tested and rejected: they split a large heading into one box per word, which is
   worse for field extraction, and are 4–6× slower.
2. **Best-of-N preprocessing.** There is no single "clean up the image" step — the fix that
   rescues a dark photo ruins a glossy one. Each card is rendered six ways (deskewed,
   contrast-lifted, sharpened, binarised, de-glared) and read each time; the best read
   wins. If even that looks poor, the four cardinal rotations are tried, which catches a
   card photographed sideways.
3. **Field extraction uses evidence, not guesswork.** Unambiguous things come out first
   (email, phone, URL, GSTIN, pincode), then they are used as evidence for the ambiguous
   ones. The strongest trick: on Indian B2B cards the domain is almost always the company
   name with the spaces removed, so `srilakshmitraders.com` confirms
   `SRI LAKSHMI TRADERS` outright — which is what stops the tagline underneath being
   mistaken for the company.
4. **Nothing is silently trusted.** Every field carries a confidence score. A lead with no
   phone *and* no email, or an unreadable photo, is flagged `needs_review` and surfaces in
   the admin. **The card photo is always stored**, so a human can always recover what the
   machine missed.

On a clean, well-lit card the system reads every field correctly at ~99% character
confidence. On a creased card shot at an angle under hall lighting, expect to correct one
field in three or four — and the review queue tells you which ones.

```bash
cd cf-ocr && python -m unittest discover -s tests -t .   # 36 parser tests, no models needed
```

When a real card parses badly at the event, add its OCR blocks to `cf-ocr/tests/test_parse.py`
as a new case before touching the heuristics. The parser is pure and dependency-free so the
tests run in milliseconds.

---

## Building the APK

Push to `main`, or run **Actions → Build Android APK → Run workflow**. The APK is attached
to the run as `cf-scanner-apk`; tick *release* to publish it as a GitHub Release with a
permanent download link. GitHub Actions is free and unmetered on public repos, so this
costs nothing.

Set these in the repo so the app ships pre-configured:

| Where | Name | Value |
|---|---|---|
| Variables | `APP_API_URL` | `https://stall.chevellafarms.com` |
| Secrets | `APP_DEVICE_KEY` | same as `DEVICE_API_KEY` in `.env` |

Without an `ANDROID_KEYSTORE_BASE64` secret the workflow produces a debug-signed APK. That
installs and runs fine and is the right default to start with — but supply a keystore
before you distribute widely, because Android will not install an update signed with a
different key:

```bash
keytool -genkey -v -keystore release.keystore -alias chevella \
        -keyalg RSA -keysize 2048 -validity 10000
base64 -i release.keystore | pbcopy        # paste as ANDROID_KEYSTORE_BASE64
```

Also add `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.

Android blocks sideloaded installs by default. On each phone:
**Settings → Apps → Special access → Install unknown apps**, and allow whichever app you
are installing from.

### Why no login in the app

Asking someone to type a password while a visitor waits is how you lose the visitor. The
app instead ships a shared device key and asks for a first name once. The key stops
strangers posting into your lead list; it is not a user identity. Rotate `DEVICE_API_KEY`
if a phone goes missing.

---

## Offline behaviour

Exhibition wifi is unreliable and mobile data inside a steel hall is worse, so the scanner
never blocks on the network. A photo is compressed and written to the phone's own storage
the instant the shutter fires; uploading happens afterwards, whenever there is signal. A
phone can take a hundred cards with no connection at all and sync them on the drive home.

Each capture carries a client-generated id that the API treats as an idempotency key, so
retrying blind can never create a duplicate. Before re-sending photos the app asks the
server which ids it already holds, so a connection that dropped *after* a successful
upload does not cost you the bandwidth twice.

The *Captured cards* screen shows exactly what is still waiting. **Do not uninstall the app
until that reaches zero.**

---

## Tests

```bash
cd cf-ocr  && python -m unittest discover -s tests -t .   # field extraction
cd cf-api  && bash test/smoke.sh                          # 26 end-to-end checks
```

The smoke test covers what would actually ruin an event day: signing in, minting a contact
QR, a visitor saving the vCard, a phone uploading a card, OCR being down not losing the
photo, the offline retry not double-inserting, and the Excel export opening.

CI runs both on every push, plus a Next.js build and all three Docker images.

---

## Data and privacy

Visiting cards are other people's personal data.

- Card photos sit on a Docker volume, served only behind authentication. **Back that volume
  up** — it is the one thing in the system that cannot be regenerated.
- Visitor IPs in the QR scan log are stored as a salted hash, never raw.
- The admin console and the public contact pages are `noindex`.
- The public page exposes only what is on a business card you would hand out anyway.

---

## Licence

Private, for Chevella Farms / Frister Foods Pvt Ltd. Every dependency is MIT, Apache-2.0 or
BSD — including the PP-OCRv5 weights (Apache-2.0), so there is nothing to license and
nothing to renew.
