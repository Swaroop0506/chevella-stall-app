#!/usr/bin/env bash
# End-to-end smoke test against a running cf-api.
#
# Covers the paths that would actually ruin an event day if they broke: signing in,
# minting a contact QR, a visitor saving the vCard, a phone uploading a card, the offline
# retry not double-inserting, and the Excel export opening.
#
#   API=http://localhost:4000 bash test/smoke.sh

set -euo pipefail

API="${API:-http://localhost:4000}"
EMAIL="${SEED_ADMIN_EMAIL:-ci@example.com}"
PASSWORD="${SEED_ADMIN_PASSWORD:-ci-password-123456}"
DEVICE_KEY="${DEVICE_API_KEY:-ci-device-key}"

JAR="$(mktemp)"
TMP="$(mktemp -d)"
trap 'rm -rf "$JAR" "$TMP"' EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# ---------------------------------------------------------------- auth

step "Auth"
code=$(curl -s -o "$TMP/login.json" -w '%{http_code}' -c "$JAR" -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
[ "$code" = "200" ] || fail "login returned $code: $(cat "$TMP/login.json")"
pass "admin can sign in"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong\"}")
[ "$code" = "401" ] || fail "wrong password returned $code, expected 401"
pass "wrong password is rejected"

code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/events")
[ "$code" = "401" ] || fail "unauthenticated /events returned $code, expected 401"
pass "admin routes require a session"

# ---------------------------------------------------------------- events

step "Events"
EVENT_ID=$(curl -s -b "$JAR" -X POST "$API/api/v1/events" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test Expo","city":"Hyderabad","status":"active"}' | json "d['event']['id']")
[ -n "$EVENT_ID" ] || fail "event was not created"
pass "event created ($EVENT_ID)"

# ---------------------------------------------------------------- contacts + QR

step "Contacts and QR codes"
CONTACT=$(curl -s -b "$JAR" -X POST "$API/api/v1/events/$EVENT_ID/contacts" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Tester","designation":"QA","phone":"9701221934"}')
CONTACT_ID=$(echo "$CONTACT" | json "d['contact']['id']")
CODE=$(echo "$CONTACT" | json "d['contact']['code']")
E164=$(echo "$CONTACT" | json "d['contact']['phone_e164']")
[ "$E164" = "+919701221934" ] || fail "phone normalised to '$E164', expected +919701221934"
pass "contact created, phone normalised to E.164"

code=$(curl -s -b "$JAR" -X POST "$API/api/v1/events/$EVENT_ID/contacts" \
  -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"name":"Bad","phone":"123"}')
[ "$code" = "400" ] || fail "invalid phone returned $code, expected 400"
pass "invalid phone is rejected"

curl -s -b "$JAR" -o "$TMP/qr.png" "$API/api/v1/contacts/$CONTACT_ID/qr.png?size=512"
python3 -c "
import sys
d = open('$TMP/qr.png','rb').read()
assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
assert len(d) > 800, f'PNG suspiciously small: {len(d)} bytes'
" || fail "contact QR PNG is not a valid image"
pass "contact QR renders as a PNG"

curl -s -b "$JAR" -o "$TMP/qrv.png" "$API/api/v1/contacts/$CONTACT_ID/qr.png?type=vcard"
head -c 8 "$TMP/qrv.png" | grep -q PNG || fail "vCard QR is not a PNG"
pass "direct-vCard QR renders"

# ---------------------------------------------------------------- public pages

step "Public contact page (what a visitor's phone hits)"
PUB=$(curl -s "$API/api/v1/public/c/$CODE")
echo "$PUB" | json "d['contact']['name']" | grep -q "Smoke Tester" || fail "public lookup failed"
echo "$PUB" | json "d['contact']['whatsapp_link']" | grep -q "wa.me/919701221934" || fail "no WhatsApp link"
pass "public lookup works without authentication"

curl -s -D "$TMP/h.txt" -o "$TMP/c.vcf" "$API/api/v1/public/c/$CODE/vcard.vcf"
grep -qi 'content-type: text/vcard' "$TMP/h.txt" || fail "vCard served with the wrong Content-Type"
grep -q 'BEGIN:VCARD' "$TMP/c.vcf" || fail "vCard body is malformed"
grep -q 'FN:Smoke Tester' "$TMP/c.vcf" || fail "vCard is missing the formatted name"
grep -q 'TEL;TYPE=CELL,VOICE:+919701221934' "$TMP/c.vcf" || fail "vCard is missing the phone"
pass "vCard downloads and parses"

curl -s -o /dev/null -X POST "$API/api/v1/public/c/$CODE/track" \
  -H 'Content-Type: application/json' -d '{"action":"whatsapp"}'
SCANS=$(curl -s -b "$JAR" "$API/api/v1/stats/contacts?event_id=$EVENT_ID" | json "d['contacts'][0]['whatsapp']")
[ "$SCANS" -ge 1 ] || fail "WhatsApp tap was not recorded"
pass "scan analytics are recorded"

code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/public/c/doesnotexist")
[ "$code" = "404" ] || fail "unknown code returned $code, expected 404"
pass "unknown QR code returns 404"

# ---------------------------------------------------------------- print pack

step "Print pack"
curl -s -b "$JAR" -o "$TMP/pack.pdf" "$API/api/v1/events/$EVENT_ID/print.pdf?mode=poster"
python3 -c "
import re
d = open('$TMP/pack.pdf','rb').read()
assert d[:5] == b'%PDF-', 'not a PDF'
pages = len(re.findall(rb'/Type\s*/Page[^s]', d))
assert pages >= 2, f'expected a website page plus one per contact, got {pages}'
assert len(d) > 20000, f'PDF too small to contain QR images: {len(d)} bytes'
" || fail "poster PDF is empty or malformed"
pass "poster pack builds with real pages"

curl -s -b "$JAR" -o "$TMP/tent.pdf" "$API/api/v1/events/$EVENT_ID/print.pdf?mode=tent"
head -c 5 "$TMP/tent.pdf" | grep -q '%PDF-' || fail "table-tent PDF is malformed"
pass "table-tent pack builds"

# ---------------------------------------------------------------- mobile app

step "Scanner app endpoints"
curl -s -H "x-api-key: $DEVICE_KEY" "$API/api/v1/app/handshake" | json "d['ok']" | grep -qi true \
  || fail "handshake failed"
pass "device key is accepted"

code=$(curl -s -o /dev/null -w '%{http_code}' -H 'x-api-key: wrong' "$API/api/v1/app/events")
[ "$code" = "401" ] || fail "bad device key returned $code, expected 401"
pass "bad device key is rejected"

curl -s -H "x-api-key: $DEVICE_KEY" "$API/api/v1/app/events" | grep -q "Smoke Test Expo" \
  || fail "active event is not visible to the app"
pass "active event is listed for the app"

# ---------------------------------------------------------------- lead capture

step "Lead capture"
python3 -c "
import struct, zlib
# Smallest valid JPEG is awkward to hand-roll; a 2x2 PNG exercises the same path.
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c))
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff'))
       + chunk(b'IEND', b''))
open('$TMP/card.png','wb').write(png)
"

RESP=$(curl -s -H "x-api-key: $DEVICE_KEY" -X POST "$API/api/v1/leads" \
  -F "card=@$TMP/card.png" -F "event_id=$EVENT_ID" -F "captured_by=SmokeBot" \
  -F "client_capture_id=smoke-001" -F "full_name=Test Lead" \
  -F "phone_primary=9876543210" -F "interest_tags=Export,HoReCa")
LEAD_ID=$(echo "$RESP" | json "d['lead']['id']")
[ -n "$LEAD_ID" ] || fail "lead was not created: $RESP"
pass "card uploads and a lead is created"

# The OCR service is intentionally unreachable in CI — the lead must still exist.
echo "$RESP" | json "d['lead']['card_image_path']" | grep -q 'cards/' || fail "card photo was not stored"
pass "card photo is stored even though OCR is down"

echo "$RESP" | json "d['lead']['phone_primary']" | grep -q '+919876543210' \
  || fail "client-supplied phone was not normalised"
pass "client-supplied fields are normalised"

AGAIN=$(curl -s -H "x-api-key: $DEVICE_KEY" -X POST "$API/api/v1/leads" \
  -F "card=@$TMP/card.png" -F "event_id=$EVENT_ID" -F "client_capture_id=smoke-001")
echo "$AGAIN" | json "d.get('duplicate_submission')" | grep -qi true \
  || fail "re-posting the same capture id created a second lead"
[ "$(echo "$AGAIN" | json "d['lead']['id']")" = "$LEAD_ID" ] || fail "idempotency returned a different lead"
pass "offline retry is idempotent"

curl -s -H "x-api-key: $DEVICE_KEY" -X POST "$API/api/v1/app/reconcile" \
  -H 'Content-Type: application/json' -d '{"capture_ids":["smoke-001","never-sent"]}' \
  | json "d['known']" | grep -q 'smoke-001' || fail "reconcile did not report the known capture"
pass "reconcile reports what the server already holds"

TOTAL=$(curl -s -b "$JAR" "$API/api/v1/leads?event_id=$EVENT_ID" | json "d['total']")
[ "$TOTAL" = "1" ] || fail "expected exactly 1 lead, found $TOTAL"
pass "exactly one lead exists after the retry"

# ---------------------------------------------------------------- review + export

step "Review and export"
curl -s -b "$JAR" -X PATCH "$API/api/v1/leads/$LEAD_ID" -H 'Content-Type: application/json' \
  -d '{"full_name":"Checked Lead","company":"Acme Foods","status":"qualified"}' \
  | json "d['lead']['needs_review']" | grep -qi false || fail "editing did not clear needs_review"
pass "saving an edit marks the lead reviewed"

curl -s -b "$JAR" -o "$TMP/leads.xlsx" "$API/api/v1/leads/export.xlsx?event_id=$EVENT_ID"
python3 -c "
import zipfile
z = zipfile.ZipFile('$TMP/leads.xlsx')
bad = z.testzip()
assert bad is None, f'corrupt entry: {bad}'
names = z.namelist()
assert any('worksheets/sheet1' in n for n in names), 'no first worksheet'
assert any('worksheets/sheet2' in n for n in names), 'no summary worksheet'
assert any(n.startswith('xl/media/') and n.endswith(('.jpeg','.jpg','.png')) for n in names), \
    'no card photo embedded in the workbook'
" || fail "Excel export is not a valid workbook"
pass "Excel export opens, has both sheets and embeds the card photo"

# ---------------------------------------------------------------- cleanup

step "Cleanup"
curl -s -b "$JAR" -o /dev/null -X DELETE "$API/api/v1/events/$EVENT_ID?force=true"
pass "test event removed"

printf '\n\033[32mAll smoke tests passed.\033[0m\n'
