import { Router } from 'express';
import { one, many, query } from '../db.js';
import { ah, HttpError, clean, pick } from '../middleware/common.js';
import { requireAdmin } from '../middleware/auth.js';
import { slugify, qrPng, qrSvg } from '../lib/qr.js';
import { buildPrintPack } from '../lib/print-pdf.js';
import { config } from '../config.js';
import { contactPublicUrl, decorateContact } from './contacts.js';

const router = Router();
router.use(requireAdmin);

const EDITABLE = ['name', 'venue', 'stall_no', 'city', 'start_date', 'end_date',
                  'status', 'website_url', 'notes'];

async function uniqueSlug(base, excludeId = null) {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const clash = await one(
      'SELECT id FROM events WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)',
      [candidate, excludeId],
    );
    if (!clash) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

// ------------------------------------------------------------------ list / create

router.get('/', ah(async (req, res) => {
  const status = clean(req.query.status);
  const rows = await many(
    `SELECT e.*,
            (SELECT count(*)::int FROM event_contacts c WHERE c.event_id = e.id AND c.is_active) AS contact_count,
            (SELECT count(*)::int FROM leads l WHERE l.event_id = e.id) AS lead_count,
            (SELECT count(*)::int FROM leads l WHERE l.event_id = e.id AND l.needs_review) AS review_count,
            (SELECT count(*)::int FROM contact_scans s
               JOIN event_contacts c ON c.id = s.contact_id
              WHERE c.event_id = e.id) AS scan_count
       FROM events e
      WHERE ($1::text IS NULL OR e.status = $1)
      ORDER BY (e.status = 'active') DESC, e.start_date DESC NULLS LAST, e.created_at DESC`,
    [status],
  );
  res.json({ events: rows });
}));

router.post('/', ah(async (req, res) => {
  const body = pick(req.body, EDITABLE);
  if (!body.name) throw new HttpError(400, 'missing_name', 'An event needs a name.');

  const slug = await uniqueSlug(clean(req.body.slug) || body.name);
  const row = await one(
    `INSERT INTO events (name, slug, venue, stall_no, city, start_date, end_date,
                         status, website_url, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8,'upcoming'),
             COALESCE($9,$11), $10, $12)
     RETURNING *`,
    [body.name, slug, body.venue, body.stall_no, body.city, body.start_date, body.end_date,
     body.status, body.website_url, body.notes, config.brand.website, req.admin.sub],
  );
  res.status(201).json({ event: row });
}));

// ------------------------------------------------------------------ single

router.get('/:id', ah(async (req, res) => {
  const event = await one('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!event) throw new HttpError(404, 'event_not_found');

  const contacts = await many(
    `SELECT c.*,
            (SELECT count(*)::int FROM contact_scans s WHERE s.contact_id = c.id) AS scan_count,
            (SELECT count(*)::int FROM contact_scans s WHERE s.contact_id = c.id AND s.action='vcard') AS save_count,
            (SELECT count(*)::int FROM contact_scans s WHERE s.contact_id = c.id AND s.action='whatsapp') AS whatsapp_count,
            (SELECT max(s.created_at) FROM contact_scans s WHERE s.contact_id = c.id) AS last_scanned_at
       FROM event_contacts c
      WHERE c.event_id = $1
      ORDER BY c.sort_order, c.created_at`,
    [event.id],
  );

  const stats = await one(
    `SELECT count(*)::int AS leads,
            count(*) FILTER (WHERE needs_review)::int AS needs_review,
            count(*) FILTER (WHERE captured_at > now() - interval '1 day')::int AS leads_24h,
            count(DISTINCT captured_by)::int AS staff
       FROM leads WHERE event_id = $1`,
    [event.id],
  );

  res.json({
    event,
    contacts: contacts.map(decorateContact),
    stats,
    website_qr: {
      png: `/api/v1/events/${event.id}/website-qr.png`,
      svg: `/api/v1/events/${event.id}/website-qr.svg`,
      target: event.website_url || config.brand.website,
    },
    print: {
      posters: `/api/v1/events/${event.id}/print.pdf?mode=poster`,
      tents: `/api/v1/events/${event.id}/print.pdf?mode=tent`,
    },
  });
}));

router.patch('/:id', ah(async (req, res) => {
  const existing = await one('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!existing) throw new HttpError(404, 'event_not_found');

  const body = pick(req.body, EDITABLE);
  const slug = req.body.slug !== undefined
    ? await uniqueSlug(clean(req.body.slug) || existing.name, existing.id)
    : existing.slug;

  const merged = { ...existing, ...body, slug };
  const row = await one(
    `UPDATE events SET name=$2, slug=$3, venue=$4, stall_no=$5, city=$6,
            start_date=$7, end_date=$8, status=$9, website_url=$10, notes=$11
      WHERE id=$1 RETURNING *`,
    [existing.id, merged.name, merged.slug, merged.venue, merged.stall_no, merged.city,
     merged.start_date, merged.end_date, merged.status, merged.website_url, merged.notes],
  );
  res.json({ event: row });
}));

router.delete('/:id', ah(async (req, res) => {
  const leads = await one('SELECT count(*)::int AS n FROM leads WHERE event_id = $1', [req.params.id]);
  if (leads.n > 0 && req.query.force !== 'true') {
    throw new HttpError(409, 'event_has_leads',
      `${leads.n} lead(s) are attached. Archive the event instead, or pass ?force=true to delete them too.`);
  }
  const row = await one('DELETE FROM events WHERE id = $1 RETURNING id', [req.params.id]);
  if (!row) throw new HttpError(404, 'event_not_found');
  res.json({ ok: true, deleted_leads: leads.n });
}));

// ------------------------------------------------------------------ website QR

async function websiteTarget(id) {
  const event = await one('SELECT id, name, website_url FROM events WHERE id = $1', [id]);
  if (!event) throw new HttpError(404, 'event_not_found');
  return { event, url: event.website_url || config.brand.website };
}

router.get('/:id/website-qr.png', ah(async (req, res) => {
  const { url } = await websiteTarget(req.params.id);
  const png = await qrPng(url, { size: Math.min(2048, Number(req.query.size) || 1024) });
  res.type('png').set('Cache-Control', 'public, max-age=300').send(png);
}));

router.get('/:id/website-qr.svg', ah(async (req, res) => {
  const { url } = await websiteTarget(req.params.id);
  res.type('svg').send(await qrSvg(url));
}));

// ------------------------------------------------------------------ print pack

router.get('/:id/print.pdf', ah(async (req, res) => {
  const event = await one('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (!event) throw new HttpError(404, 'event_not_found');

  const contacts = await many(
    `SELECT * FROM event_contacts WHERE event_id = $1 AND is_active
      ORDER BY sort_order, created_at`,
    [event.id],
  );

  const withUrls = contacts.map((c) => ({ ...c, url: contactPublicUrl(c.code) }));
  const pdf = await buildPrintPack(event, withUrls, { mode: req.query.mode });

  const name = `${slugify(event.name)}-qr-${req.query.mode === 'tent' ? 'table-tents' : 'posters'}.pdf`;
  res
    .type('pdf')
    .set('Content-Disposition', `${req.query.download === 'false' ? 'inline' : 'attachment'}; filename="${name}"`)
    .send(pdf);
}));

export default router;
