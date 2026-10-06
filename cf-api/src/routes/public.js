// Unauthenticated endpoints — these are what a visitor's phone hits after scanning a QR.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, query } from '../db.js';
import { ah, HttpError, hashIp } from '../middleware/common.js';
import { buildVCard, vcardFilename } from '../lib/vcard.js';
import { prettyIndian, isIndianMobile, waLink } from '../lib/phone.js';
import { config } from '../config.js';

const router = Router();

// Generous, but enough to stop a scraper walking the code space.
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'slow_down' },
}));

const ACTIONS = new Set(['view', 'vcard', 'whatsapp', 'call', 'website']);

async function track(contactId, action, req) {
  if (!ACTIONS.has(action)) return;
  try {
    await query(
      `INSERT INTO contact_scans (contact_id, action, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4)`,
      [contactId, action, String(req.headers['user-agent'] || '').slice(0, 400), hashIp(req.ip)],
    );
  } catch (err) {
    // Analytics must never break the visitor's flow.
    console.warn('[track] failed:', err.message);
  }
}

async function loadByCode(code) {
  const row = await one(
    `SELECT c.*, e.name AS event_name, e.venue AS event_venue, e.stall_no, e.status AS event_status
       FROM event_contacts c JOIN events e ON e.id = c.event_id
      WHERE c.code = $1`,
    [String(code || '').toLowerCase()],
  );
  if (!row) throw new HttpError(404, 'contact_not_found');
  return row;
}

/** Everything the landing page renders. Records a 'view'. */
router.get('/c/:code', ah(async (req, res) => {
  const c = await loadByCode(req.params.code);
  if (!c.is_active) throw new HttpError(410, 'contact_inactive');

  await track(c.id, 'view', req);

  const wa = c.whatsapp_e164 || c.phone_e164;
  res.set('Cache-Control', 'no-store').json({
    contact: {
      code: c.code,
      name: c.name,
      designation: c.designation,
      company: c.company || config.brand.company,
      phone: c.phone_e164,
      phone_display: prettyIndian(c.phone_e164),
      whatsapp: wa,
      whatsapp_display: prettyIndian(wa),
      whatsapp_reachable: isIndianMobile(wa),
      whatsapp_link: waLink(wa, c.wa_prefill),
      email: c.email,
      website_url: c.website_url || config.brand.website,
      address: c.address || config.brand.address,
      event_name: c.event_name,
      event_venue: c.event_venue,
      stall_no: c.stall_no,
      vcard_url: `/api/v1/public/c/${c.code}/vcard.vcf`,
    },
    brand: {
      company: config.brand.company,
      tagline: config.brand.tagline,
      website: config.brand.website,
      email: config.brand.email,
      phone: config.brand.phone,
      address: config.brand.address,
    },
  });
}));

/** The actual "save to my phone" action. */
router.get('/c/:code/vcard.vcf', ah(async (req, res) => {
  const c = await loadByCode(req.params.code);
  if (!c.is_active) throw new HttpError(410, 'contact_inactive');

  await track(c.id, 'vcard', req);

  const vcf = buildVCard({
    ...c,
    whatsapp_e164: c.whatsapp_e164 || c.phone_e164,
    website_url: c.website_url || config.brand.website,
    address: c.address || config.brand.address,
    event_name: c.event_name,
  });

  res
    // text/vcard is what makes iOS offer "Add to Contacts" instead of showing raw text.
    .type('text/vcard; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="${vcardFilename(`${c.name}-chevella-farms`)}"`)
    .set('Cache-Control', 'no-store')
    .send(vcf);
}));

/** Fired by the landing page when the visitor taps WhatsApp / Call / Website. */
router.post('/c/:code/track', ah(async (req, res) => {
  const c = await loadByCode(req.params.code);
  const action = String(req.body?.action || '').toLowerCase();
  if (!ACTIONS.has(action)) throw new HttpError(400, 'bad_action');
  await track(c.id, action, req);
  res.json({ ok: true });
}));

export default router;
