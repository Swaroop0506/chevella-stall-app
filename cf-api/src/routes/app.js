// Endpoints the Android app uses. Device-key only — no user accounts, by design.
import { Router } from 'express';
import { many, one } from '../db.js';
import { ah } from '../middleware/common.js';
import { requireDeviceKey } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();
router.use(requireDeviceKey);

/** Lets the app confirm its key and base URL before anyone walks up to the stall. */
router.get('/handshake', ah(async (_req, res) => {
  res.json({
    ok: true,
    brand: { company: config.brand.company, tagline: config.brand.tagline },
    server_time: new Date().toISOString(),
    max_upload_mb: config.maxUploadMb,
    // Tags the capture screen offers as chips; editing them here updates every phone.
    interest_tags: [
      'Instant Coconut Water Powder', 'Tender Coconut Water', 'Bulk / Distributor',
      'Retail / Store', 'HoReCa', 'Export', 'Private Label', 'Just browsing',
    ],
  });
}));

/** Events the staff can pick from. Active first — that is almost always the right one. */
router.get('/events', ah(async (_req, res) => {
  const events = await many(
    `SELECT id, name, venue, stall_no, city, start_date, end_date, status
       FROM events
      WHERE status IN ('active','upcoming')
      ORDER BY (status = 'active') DESC, start_date NULLS LAST, name`,
  );
  res.json({ events });
}));

/** What this phone has already sent for an event — lets the app show a live counter. */
router.get('/events/:id/summary', ah(async (req, res) => {
  const by = req.query.captured_by || null;
  const row = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE captured_at::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
            count(*) FILTER (WHERE $2::text IS NOT NULL AND captured_by = $2)::int AS mine
       FROM leads WHERE event_id = $1`,
    [req.params.id, by],
  );
  res.json({ summary: row });
}));

/**
 * Echoes back which client_capture_ids the server already holds, so the app can
 * clear its offline queue after a flaky upload without re-sending photos.
 */
router.post('/reconcile', ah(async (req, res) => {
  const ids = Array.isArray(req.body?.capture_ids) ? req.body.capture_ids.slice(0, 500) : [];
  if (!ids.length) return res.json({ known: [] });
  const rows = await many(
    'SELECT client_capture_id FROM leads WHERE client_capture_id = ANY($1::text[])', [ids]);
  res.json({ known: rows.map((r) => r.client_capture_id) });
}));

export default router;
