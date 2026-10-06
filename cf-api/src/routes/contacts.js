import { Router } from 'express';
import { one, many, tx } from '../db.js';
import { ah, HttpError, clean, pick } from '../middleware/common.js';
import { requireAdmin } from '../middleware/auth.js';
import { shortCode, qrPng, qrSvg, vcardFitsInQr } from '../lib/qr.js';
import { buildVCard, vcardFilename } from '../lib/vcard.js';
import { toE164, isIndianMobile, prettyIndian, waLink } from '../lib/phone.js';
import { config } from '../config.js';

const router = Router();

export function contactPublicUrl(code) {
  return `${config.publicBaseUrl}/c/${code}`;
}

/** Adds everything the admin UI and the print pack need, derived not stored. */
export function decorateContact(c) {
  const wa = c.whatsapp_e164 || c.phone_e164;
  const vcard = buildVCard({ ...c, whatsapp_e164: wa }, { minimal: true });
  return {
    ...c,
    public_url: contactPublicUrl(c.code),
    phone_display: prettyIndian(c.phone_e164),
    whatsapp_display: prettyIndian(wa),
    whatsapp_reachable: isIndianMobile(wa),
    whatsapp_link: waLink(wa, c.wa_prefill),
    qr_png: `/api/v1/contacts/${c.id}/qr.png`,
    qr_svg: `/api/v1/contacts/${c.id}/qr.svg`,
    qr_vcard_png: `/api/v1/contacts/${c.id}/qr.png?type=vcard`,
    vcard_url: `/api/v1/contacts/${c.id}/vcard.vcf`,
    // A direct-vCard QR only gets offered when the payload still scans reliably.
    vcard_qr_available: vcardFitsInQr(vcard),
  };
}

const EDITABLE = ['name', 'designation', 'company', 'email', 'website_url',
                  'address', 'wa_prefill', 'label'];

function defaultPrefill(event, contact) {
  return `Hi ${contact.name || config.brand.company}, I met you at ${event?.name || 'your stall'} ` +
         `and I'd like to know more about Chevella Farms coconut water.`;
}

async function newCode() {
  for (let i = 0; i < 25; i++) {
    const code = shortCode(8);
    const clash = await one('SELECT id FROM event_contacts WHERE code = $1', [code]);
    if (!clash) return code;
  }
  throw new HttpError(500, 'code_exhausted');
}

// ------------------------------------------------------------ list / create (nested)

router.get('/events/:eventId/contacts', requireAdmin, ah(async (req, res) => {
  const rows = await many(
    `SELECT c.*,
            (SELECT count(*)::int FROM contact_scans s WHERE s.contact_id = c.id) AS scan_count
       FROM event_contacts c WHERE c.event_id = $1
      ORDER BY c.sort_order, c.created_at`,
    [req.params.eventId],
  );
  res.json({ contacts: rows.map(decorateContact) });
}));

router.post('/events/:eventId/contacts', requireAdmin, ah(async (req, res) => {
  const event = await one('SELECT id, name, website_url FROM events WHERE id = $1', [req.params.eventId]);
  if (!event) throw new HttpError(404, 'event_not_found');

  const body = pick(req.body, EDITABLE);
  if (!body.name) throw new HttpError(400, 'missing_name', 'A contact needs a name.');

  const phone = toE164(req.body.phone_e164 ?? req.body.phone);
  if (!phone) throw new HttpError(400, 'bad_phone', 'Enter a valid phone number, e.g. 9701221934.');

  const waRaw = req.body.whatsapp_e164 ?? req.body.whatsapp;
  const whatsapp = waRaw ? toE164(waRaw) : phone;
  if (waRaw && !whatsapp) throw new HttpError(400, 'bad_whatsapp', 'That WhatsApp number does not look valid.');

  const order = req.body.sort_order != null
    ? Number(req.body.sort_order)
    : ((await one('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM event_contacts WHERE event_id = $1',
        [event.id])).n);

  const row = await one(
    `INSERT INTO event_contacts
       (event_id, code, name, designation, company, phone_e164, whatsapp_e164,
        email, website_url, address, wa_prefill, sort_order)
     VALUES ($1,$2,$3,$4, COALESCE($5,$13), $6,$7,$8, COALESCE($9,$14), $10, $11, $12)
     RETURNING *`,
    [event.id, await newCode(), body.name, body.designation, body.company, phone, whatsapp,
     body.email, body.website_url, body.address,
     body.wa_prefill || defaultPrefill(event, body), order,
     config.brand.company, event.website_url || config.brand.website],
  );

  res.status(201).json({ contact: decorateContact(row) });
}));

// ------------------------------------------------------------ single

async function loadContact(id) {
  const row = await one('SELECT * FROM event_contacts WHERE id = $1', [id]);
  if (!row) throw new HttpError(404, 'contact_not_found');
  return row;
}

router.get('/contacts/:id', requireAdmin, ah(async (req, res) => {
  const contact = await loadContact(req.params.id);
  const scans = await many(
    `SELECT action, count(*)::int AS n, max(created_at) AS last_at
       FROM contact_scans WHERE contact_id = $1 GROUP BY action`,
    [contact.id],
  );
  res.json({ contact: decorateContact(contact), scans });
}));

router.patch('/contacts/:id', requireAdmin, ah(async (req, res) => {
  const existing = await loadContact(req.params.id);
  const body = pick(req.body, EDITABLE);

  let phone = existing.phone_e164;
  if (req.body.phone_e164 !== undefined || req.body.phone !== undefined) {
    phone = toE164(req.body.phone_e164 ?? req.body.phone);
    if (!phone) throw new HttpError(400, 'bad_phone');
  }
  let whatsapp = existing.whatsapp_e164;
  if (req.body.whatsapp_e164 !== undefined || req.body.whatsapp !== undefined) {
    const raw = req.body.whatsapp_e164 ?? req.body.whatsapp;
    whatsapp = raw ? toE164(raw) : phone;
    if (raw && !whatsapp) throw new HttpError(400, 'bad_whatsapp');
  }

  const m = { ...existing, ...body, phone_e164: phone, whatsapp_e164: whatsapp };
  if (req.body.is_active !== undefined) m.is_active = Boolean(req.body.is_active);
  if (req.body.sort_order !== undefined) m.sort_order = Number(req.body.sort_order);

  const row = await one(
    `UPDATE event_contacts SET name=$2, designation=$3, company=$4, phone_e164=$5,
            whatsapp_e164=$6, email=$7, website_url=$8, address=$9, wa_prefill=$10,
            sort_order=$11, is_active=$12
      WHERE id=$1 RETURNING *`,
    [existing.id, m.name, m.designation, m.company, m.phone_e164, m.whatsapp_e164,
     m.email, m.website_url, m.address, m.wa_prefill, m.sort_order, m.is_active],
  );
  res.json({ contact: decorateContact(row) });
}));

router.delete('/contacts/:id', requireAdmin, ah(async (req, res) => {
  // Soft-delete by default: a printed QR in someone's hand should not start 404-ing.
  if (req.query.hard === 'true') {
    const row = await one('DELETE FROM event_contacts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!row) throw new HttpError(404, 'contact_not_found');
    return res.json({ ok: true, hard: true });
  }
  const row = await one(
    'UPDATE event_contacts SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]);
  if (!row) throw new HttpError(404, 'contact_not_found');
  res.json({ ok: true, hard: false });
}));

router.post('/contacts/reorder', requireAdmin, ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) throw new HttpError(400, 'missing_ids');
  await tx(async (c) => {
    for (const [i, id] of ids.entries()) {
      await c.query('UPDATE event_contacts SET sort_order = $1 WHERE id = $2', [i, id]);
    }
  });
  res.json({ ok: true });
}));

/** Rotates the short code — use it if a wrong QR already went to print. */
router.post('/contacts/:id/rotate-code', requireAdmin, ah(async (req, res) => {
  const contact = await loadContact(req.params.id);
  const row = await one(
    'UPDATE event_contacts SET code = $2 WHERE id = $1 RETURNING *',
    [contact.id, await newCode()],
  );
  res.json({ contact: decorateContact(row) });
}));

// ------------------------------------------------------------ QR + vCard

function qrPayload(contact, type) {
  if (type === 'vcard') {
    const vcard = buildVCard(
      { ...contact, whatsapp_e164: contact.whatsapp_e164 || contact.phone_e164 },
      { minimal: true },
    );
    if (!vcardFitsInQr(vcard)) {
      throw new HttpError(422, 'vcard_too_large',
        'This contact has too much data for a reliable direct-vCard QR. Use the default page QR.');
    }
    return vcard;
  }
  return contactPublicUrl(contact.code);
}

router.get('/contacts/:id/qr.png', requireAdmin, ah(async (req, res) => {
  const contact = await loadContact(req.params.id);
  const size = Math.min(2048, Math.max(128, Number(req.query.size) || 1024));
  const png = await qrPng(qrPayload(contact, req.query.type), { size });
  res.type('png')
     .set('Content-Disposition', `inline; filename="qr-${contact.code}.png"`)
     .set('Cache-Control', 'private, max-age=60')
     .send(png);
}));

router.get('/contacts/:id/qr.svg', requireAdmin, ah(async (req, res) => {
  const contact = await loadContact(req.params.id);
  res.type('svg').send(await qrSvg(qrPayload(contact, req.query.type)));
}));

router.get('/contacts/:id/vcard.vcf', requireAdmin, ah(async (req, res) => {
  const contact = await loadContact(req.params.id);
  const event = await one('SELECT name FROM events WHERE id = $1', [contact.event_id]);
  const vcf = buildVCard({ ...contact, event_name: event?.name });
  res.type('text/vcard; charset=utf-8')
     .set('Content-Disposition', `attachment; filename="${vcardFilename(contact.name)}"`)
     .send(vcf);
}));

export default router;
