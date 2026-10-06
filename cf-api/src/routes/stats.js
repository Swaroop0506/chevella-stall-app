import { Router } from 'express';
import { many, one } from '../db.js';
import { ah, HttpError, clean } from '../middleware/common.js';
import { requireAdmin, requireAdminOrDevice } from '../middleware/auth.js';
import { storageAbs } from '../lib/images.js';
import { ocrHealth } from '../lib/ocr-client.js';
import { qrPng } from '../lib/qr.js';
import { config } from '../config.js';

const router = Router();

/** Generic QR generator — used for the APK download link on the scanner-setup page. */
router.get('/qr.png', requireAdmin, ah(async (req, res) => {
  const text = clean(req.query.text);
  if (!text) throw new HttpError(400, 'missing_text');
  if (text.length > 1200) throw new HttpError(413, 'text_too_long');
  const size = Math.min(2048, Math.max(128, Number(req.query.size) || 512));
  res.type('png')
     .set('Cache-Control', 'private, max-age=3600')
     .send(await qrPng(text, { size }));
}));

/** Everything the scanner-setup page needs to show, including the device key. */
router.get('/app-config', requireAdmin, ah(async (_req, res) => {
  res.json({
    api_public_url: config.apiPublicUrl,
    public_base_url: config.publicBaseUrl,
    device_api_key: config.deviceApiKey,
    apk_url: process.env.APK_DOWNLOAD_URL || null,
    max_upload_mb: config.maxUploadMb,
  });
}));

/** Dashboard numbers. One round trip, because the admin home should feel instant. */
router.get('/stats/overview', requireAdmin, ah(async (_req, res) => {
  const [totals, byEvent, byStaff, byDay, scans, tags] = await Promise.all([
    one(`SELECT
            (SELECT count(*)::int FROM events)                              AS events,
            (SELECT count(*)::int FROM events WHERE status = 'active')      AS active_events,
            (SELECT count(*)::int FROM event_contacts WHERE is_active)      AS contacts,
            (SELECT count(*)::int FROM leads)                               AS leads,
            (SELECT count(*)::int FROM leads WHERE needs_review)            AS needs_review,
            (SELECT count(*)::int FROM leads
              WHERE captured_at::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS leads_today,
            (SELECT count(*)::int FROM contact_scans)                       AS total_scans,
            (SELECT count(*)::int FROM contact_scans WHERE action = 'vcard') AS contacts_saved,
            (SELECT count(*)::int FROM contact_scans WHERE action = 'whatsapp') AS whatsapp_clicks,
            (SELECT round(avg(ocr_confidence)::numeric, 4) FROM leads WHERE ocr_confidence IS NOT NULL)
                                                                            AS avg_ocr_confidence`),

    many(`SELECT e.id, e.name, e.status,
                 count(l.id)::int AS leads,
                 count(l.id) FILTER (WHERE l.needs_review)::int AS needs_review
            FROM events e LEFT JOIN leads l ON l.event_id = e.id
           GROUP BY e.id, e.name, e.status
           ORDER BY leads DESC, e.name LIMIT 12`),

    many(`SELECT COALESCE(captured_by, 'unknown') AS staff, count(*)::int AS leads
            FROM leads GROUP BY 1 ORDER BY leads DESC LIMIT 12`),

    many(`SELECT (captured_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*)::int AS leads
            FROM leads
           WHERE captured_at > now() - interval '30 days'
           GROUP BY 1 ORDER BY 1`),

    many(`SELECT action, count(*)::int AS n FROM contact_scans GROUP BY 1 ORDER BY n DESC`),

    many(`SELECT tag, count(*)::int AS n
            FROM leads, unnest(interest_tags) AS tag
           GROUP BY 1 ORDER BY n DESC LIMIT 15`),
  ]);

  res.json({ totals, by_event: byEvent, by_staff: byStaff, by_day: byDay, scans, tags });
}));

/** Per-contact QR performance — which person's QR is actually getting scanned. */
router.get('/stats/contacts', requireAdmin, ah(async (req, res) => {
  const rows = await many(
    `SELECT c.id, c.name, c.designation, c.code, e.name AS event_name,
            count(s.id)::int                                        AS views,
            count(s.id) FILTER (WHERE s.action = 'vcard')::int      AS saves,
            count(s.id) FILTER (WHERE s.action = 'whatsapp')::int   AS whatsapp,
            count(s.id) FILTER (WHERE s.action = 'call')::int       AS calls,
            max(s.created_at)                                       AS last_scan
       FROM event_contacts c
       JOIN events e ON e.id = c.event_id
       LEFT JOIN contact_scans s ON s.contact_id = c.id
      WHERE ($1::uuid IS NULL OR c.event_id = $1)
      GROUP BY c.id, c.name, c.designation, c.code, e.name
      ORDER BY views DESC, c.name`,
    [req.query.event_id || null],
  );
  res.json({ contacts: rows });
}));

/** Serves a stored card photo. Behind auth — these are other people's business cards. */
router.get('/files/*', requireAdminOrDevice, ah(async (req, res) => {
  const rel = req.params[0];
  const abs = storageAbs(rel);
  if (!abs) throw new HttpError(400, 'bad_path');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(abs, { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file_not_found' });
  });
}));

/** Liveness + a readable report of what is and isn't wired up. */
router.get('/health', ah(async (_req, res) => {
  const db = await one('SELECT 1 AS ok').then(() => true).catch(() => false);
  const ocr = await ocrHealth();
  const healthy = db && ocr.ok;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    db,
    ocr,
    uptime_s: Math.round(process.uptime()),
    version: process.env.APP_VERSION || 'dev',
  });
}));

export default router;
