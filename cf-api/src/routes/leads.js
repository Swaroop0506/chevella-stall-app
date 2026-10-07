import { Router } from 'express';
import { one, many, query } from '../db.js';
import { ah, HttpError, clean, cardUpload } from '../middleware/common.js';
import { requireAdmin, requireAdminOrDevice } from '../middleware/auth.js';
import { storeCardImage, readStorage } from '../lib/images.js';
import { ocrCard } from '../lib/ocr-client.js';
import { toE164 } from '../lib/phone.js';
import { leadsWorkbook, exportFilename } from '../lib/excel.js';
import {
  mergeCardFields, mergeConfidence, needsReview as needsReviewFor,
} from '../lib/merge-card.js';

const router = Router();

const PARSED_FIELDS = [
  'full_name', 'designation', 'company', 'phone_primary', 'phone_secondary', 'whatsapp',
  'email', 'email_secondary', 'website', 'address', 'city', 'state', 'pincode', 'gstin',
];

function normaliseTags(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Phone-ish fields get E.164'd on the way in, wherever they came from. */
function normalisePhones(f) {
  for (const k of ['phone_primary', 'phone_secondary', 'whatsapp']) {
    if (f[k]) f[k] = toE164(f[k]) || f[k];
  }
  return f;
}

// ------------------------------------------------------------------ capture

/**
 * The endpoint the phone posts a card photo to. Deliberately forgiving:
 *  - idempotent on client_capture_id, so the offline queue can retry blind
 *  - saves the lead even when OCR fails, because the photo is the real record
 */
router.post(
  '/',
  requireAdminOrDevice,
  cardUpload.fields([{ name: 'card', maxCount: 1 }, { name: 'card_back', maxCount: 1 }]),
  ah(async (req, res) => {
    const file = req.files?.card?.[0] || req.files?.card_back?.[0];
    if (!file) throw new HttpError(400, 'missing_card', 'Attach the card photo as the "card" field.');

    const eventId = clean(req.body.event_id);
    if (!eventId) throw new HttpError(400, 'missing_event_id');
    const event = await one('SELECT id, name FROM events WHERE id = $1', [eventId]);
    if (!event) throw new HttpError(404, 'event_not_found');

    const captureId = clean(req.body.client_capture_id);

    // Idempotency: a retried upload returns the lead that already landed.
    if (captureId) {
      const existing = await one('SELECT * FROM leads WHERE client_capture_id = $1', [captureId]);
      if (existing) {
        return res.status(200).json({ lead: existing, duplicate_submission: true });
      }
    }

    const stored = await storeCardImage(file.buffer);
    const skipOcr = String(req.body.skip_ocr || '') === 'true';

    const ocr = skipOcr
      ? { ok: false, error: 'skipped' }
      : await ocrCard(stored.ocrBuffer, file.originalname);

    // The back, when the phone sent both sides in one go. Read it too: on Indian B2B
    // cards the address and GSTIN are usually only on the reverse.
    let back = null;
    let backOcr = null;
    const backFile = req.files?.card?.[0] ? req.files?.card_back?.[0] : null;
    if (backFile) {
      back = await storeCardImage(backFile.buffer);
      backOcr = skipOcr
        ? { ok: false, error: 'skipped' }
        : await ocrCard(back.ocrBuffer, backFile.originalname);
    }

    const { merged, filled } = mergeCardFields(
      normalisePhones({ ...(ocr.fields || {}) }),
      normalisePhones({ ...(backOcr?.fields || {}) }),
    );

    // Fields the phone already corrected beat anything either side's OCR produced.
    const fromClient = {};
    for (const k of PARSED_FIELDS) {
      const v = clean(req.body[k]);
      if (v) fromClient[k] = v;
    }
    const fields = normalisePhones({ ...merged, ...fromClient });

    const review = req.body.needs_review !== undefined
      ? String(req.body.needs_review) === 'true'
      : needsReviewFor(fields, {
          ocrFailed: !ocr.ok && !skipOcr,
          imageWarnings: ocr.image_quality?.warnings || [],
        });

    const lead = await one(
      `INSERT INTO leads (
          event_id, client_capture_id, captured_by, device_label, captured_at,
          card_image_path, card_thumb_path, card_back_path, card_back_thumb_path,
          ocr_engine, ocr_version, ocr_raw_text, ocr_blocks, ocr_confidence, ocr_ms,
          ocr_back_text, ocr_back_confidence, back_filled_fields,
          full_name, designation, company, phone_primary, phone_secondary, whatsapp,
          email, email_secondary, website, address, city, state, pincode, gstin,
          field_confidence, needs_review, interest_tags, notes)
       VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now()),
               $6,$7,$8,$9,
               $10,$11,$12,$13,$14,$15,
               $16,$17,$18,
               $19,$20,$21,$22,$23,$24,
               $25,$26,$27,$28,$29,$30,$31,$32,
               $33,$34,$35,$36)
       RETURNING *`,
      [
        event.id, captureId, clean(req.body.captured_by), clean(req.body.device_label),
        clean(req.body.captured_at),
        stored.cardPath, stored.thumbPath, back?.cardPath || null, back?.thumbPath || null,
        ocr.engine || null, ocr.version || null, ocr.raw_text || null,
        ocr.blocks ? JSON.stringify(ocr.blocks) : null,
        ocr.confidence ?? null, ocr.ms ?? null,
        backOcr?.raw_text || null, backOcr?.confidence ?? null,
        Object.keys(filled).length ? JSON.stringify(filled) : null,
        fields.full_name || null, fields.designation || null, fields.company || null,
        fields.phone_primary || null, fields.phone_secondary || null, fields.whatsapp || null,
        fields.email || null, fields.email_secondary || null, fields.website || null,
        fields.address || null, fields.city || null, fields.state || null,
        fields.pincode || null, fields.gstin || null,
        JSON.stringify(mergeConfidence(ocr.field_confidence, backOcr?.field_confidence, filled)),
        review, normaliseTags(req.body.interest_tags), clean(req.body.notes),
      ],
    );

    const dupe = await findPossibleDuplicate(lead);

    res.status(201).json({
      lead,
      ocr: {
        ok: ocr.ok,
        error: ocr.error || null,
        confidence: ocr.confidence ?? null,
        ms: ocr.ms,
        back: backOcr ? { ok: backOcr.ok, confidence: backOcr.confidence ?? null } : null,
        back_filled: Object.keys(filled),
      },
      possible_duplicate: dupe,
    });
  }),
);

/**
 * Attaches the back of a card to a lead that already exists.
 *
 * Needed because the two sides are very often captured a moment apart — and because an
 * offline phone may well have uploaded the front before anyone thought to flip the card
 * over. Idempotent in the way that matters: sending a back twice simply replaces it.
 */
router.post(
  '/:id/back',
  requireAdminOrDevice,
  cardUpload.fields([{ name: 'card_back', maxCount: 1 }, { name: 'card', maxCount: 1 }]),
  ah(async (req, res) => {
    const file = req.files?.card_back?.[0] || req.files?.card?.[0];
    if (!file) throw new HttpError(400, 'missing_card_back', 'Attach the photo as "card_back".');

    const lead = await one('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!lead) throw new HttpError(404, 'lead_not_found');

    const back = await storeCardImage(file.buffer);
    const backOcr = String(req.body.skip_ocr || '') === 'true'
      ? { ok: false, error: 'skipped' }
      : await ocrCard(back.ocrBuffer, file.originalname);

    // Everything already on the lead is treated as the front — including any correction a
    // human has since made, which must not be undone by a late back-of-card read.
    const frontFields = {};
    for (const k of PARSED_FIELDS) frontFields[k] = lead[k];

    const { merged, filled } = mergeCardFields(
      frontFields,
      normalisePhones({ ...(backOcr.fields || {}) }),
    );

    const review = lead.reviewed_at
      ? lead.needs_review          // a human already signed this off; leave their verdict
      : needsReviewFor(merged, { ocrFailed: !backOcr.ok && lead.ocr_engine === null });

    const updated = await one(
      `UPDATE leads SET
          card_back_path=$2, card_back_thumb_path=$3,
          ocr_back_text=$4, ocr_back_confidence=$5,
          back_filled_fields = COALESCE(back_filled_fields, '{}'::jsonb) || $6::jsonb,
          field_confidence   = COALESCE(field_confidence,   '{}'::jsonb) || $7::jsonb,
          full_name=$8, designation=$9, company=$10, phone_primary=$11, phone_secondary=$12,
          whatsapp=$13, email=$14, email_secondary=$15, website=$16, address=$17,
          city=$18, state=$19, pincode=$20, gstin=$21,
          needs_review=$22
        WHERE id=$1 RETURNING *`,
      [
        lead.id, back.cardPath, back.thumbPath,
        backOcr.raw_text || null, backOcr.confidence ?? null,
        JSON.stringify(filled),
        JSON.stringify(mergeConfidence({}, backOcr.field_confidence, filled)),
        merged.full_name || null, merged.designation || null, merged.company || null,
        merged.phone_primary || null, merged.phone_secondary || null, merged.whatsapp || null,
        merged.email || null, merged.email_secondary || null, merged.website || null,
        merged.address || null, merged.city || null, merged.state || null,
        merged.pincode || null, merged.gstin || null,
        review,
      ],
    );

    res.json({
      lead: updated,
      ocr: { ok: backOcr.ok, error: backOcr.error || null, confidence: backOcr.confidence ?? null },
      filled: Object.keys(filled),
    });
  }),
);

/** Same phone or email already captured at this event — surfaced, never auto-merged. */
async function findPossibleDuplicate(lead) {
  if (!lead.phone_primary && !lead.email) return null;
  return one(
    `SELECT id, full_name, company, phone_primary, email, captured_at, captured_by
       FROM leads
      WHERE event_id = $1 AND id <> $2
        AND ( ($3::text IS NOT NULL AND phone_primary = $3)
           OR ($4::text IS NOT NULL AND lower(email) = lower($4)) )
      ORDER BY captured_at DESC LIMIT 1`,
    [lead.event_id, lead.id, lead.phone_primary, lead.email],
  );
}

// ------------------------------------------------------------------ list

router.get('/', requireAdmin, ah(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const where = [];
  const p = [];
  /** Pushes one value and returns its placeholder, so numbering can never drift. */
  const bind = (val) => { p.push(val); return `$${p.length}`; };

  if (clean(req.query.event_id)) where.push(`l.event_id = ${bind(req.query.event_id)}`);
  if (clean(req.query.status)) where.push(`l.status = ${bind(req.query.status)}`);
  if (req.query.needs_review === 'true') where.push('l.needs_review');
  if (req.query.needs_review === 'false') where.push('NOT l.needs_review');
  if (clean(req.query.captured_by)) {
    where.push(`l.captured_by ILIKE ${bind(`%${req.query.captured_by}%`)}`);
  }
  if (clean(req.query.from)) where.push(`l.captured_at >= ${bind(req.query.from)}::timestamptz`);
  if (clean(req.query.to)) where.push(`l.captured_at <= ${bind(req.query.to)}::timestamptz`);
  if (clean(req.query.q)) {
    // One placeholder reused across every searched column.
    const ph = bind(`%${req.query.q}%`);
    where.push(`(l.full_name ILIKE ${ph} OR l.company ILIKE ${ph} OR l.email ILIKE ${ph}
                 OR l.phone_primary ILIKE ${ph} OR l.city ILIKE ${ph} OR l.ocr_raw_text ILIKE ${ph})`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await many(
    `SELECT l.*, e.name AS event_name
       FROM leads l JOIN events e ON e.id = l.event_id
       ${clause}
      ORDER BY l.captured_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    p,
  );

  const total = await one(
    `SELECT count(*)::int AS n FROM leads l ${clause}`, p);

  res.json({ leads: rows, total: total.n, limit, offset });
}));

router.get('/export.xlsx', requireAdmin, ah(async (req, res) => {
  const where = [];
  const p = [];
  if (clean(req.query.event_id)) { p.push(req.query.event_id); where.push(`l.event_id = $${p.length}`); }
  if (clean(req.query.status)) { p.push(req.query.status); where.push(`l.status = $${p.length}`); }
  if (req.query.needs_review === 'true') where.push('l.needs_review');
  if (clean(req.query.from)) { p.push(req.query.from); where.push(`l.captured_at >= $${p.length}::timestamptz`); }
  if (clean(req.query.to)) { p.push(req.query.to); where.push(`l.captured_at <= $${p.length}::timestamptz`); }

  const rows = await many(
    `SELECT l.*, e.name AS event_name
       FROM leads l JOIN events e ON e.id = l.event_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.captured_at DESC`,
    p,
  );

  const eventName = clean(req.query.event_id) ? rows[0]?.event_name : null;
  const buf = await leadsWorkbook(rows, {
    images: req.query.images !== 'false',   // embedded card photos are on by default
    eventName,
  });

  res
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="${exportFilename(eventName)}"`)
    .send(buf);
}));

// ------------------------------------------------------------------ single

router.get('/:id', requireAdminOrDevice, ah(async (req, res) => {
  const lead = await one(
    `SELECT l.*, e.name AS event_name FROM leads l JOIN events e ON e.id = l.event_id
      WHERE l.id = $1`, [req.params.id]);
  if (!lead) throw new HttpError(404, 'lead_not_found');
  res.json({ lead, possible_duplicate: await findPossibleDuplicate(lead) });
}));

const LEAD_EDITABLE = [...PARSED_FIELDS, 'notes', 'status'];

router.patch('/:id', requireAdminOrDevice, ah(async (req, res) => {
  const existing = await one('SELECT * FROM leads WHERE id = $1', [req.params.id]);
  if (!existing) throw new HttpError(404, 'lead_not_found');

  const patch = {};
  for (const k of LEAD_EDITABLE) if (k in req.body) patch[k] = clean(req.body[k]);
  normalisePhones(patch);

  const m = { ...existing, ...patch };
  const tags = req.body.interest_tags !== undefined
    ? normaliseTags(req.body.interest_tags) : existing.interest_tags;

  // Any human edit clears the review flag unless the caller says otherwise.
  const reviewed = req.body.needs_review !== undefined
    ? Boolean(req.body.needs_review) : false;

  const row = await one(
    `UPDATE leads SET
        full_name=$2, designation=$3, company=$4, phone_primary=$5, phone_secondary=$6,
        whatsapp=$7, email=$8, email_secondary=$9, website=$10, address=$11, city=$12,
        state=$13, pincode=$14, gstin=$15, notes=$16, status=$17,
        interest_tags=$18, needs_review=$19,
        reviewed_at = CASE WHEN $19 THEN reviewed_at ELSE now() END,
        reviewed_by = CASE WHEN $19 THEN reviewed_by ELSE $20::uuid END
      WHERE id=$1 RETURNING *`,
    [existing.id, m.full_name, m.designation, m.company, m.phone_primary, m.phone_secondary,
     m.whatsapp, m.email, m.email_secondary, m.website, m.address, m.city, m.state,
     m.pincode, m.gstin, m.notes, m.status || 'new', tags, reviewed,
     req.admin?.sub || null],
  );
  res.json({ lead: row });
}));

/** Re-runs OCR on the stored photo — useful after an OCR-service upgrade. */
router.post('/:id/reocr', requireAdmin, ah(async (req, res) => {
  const lead = await one('SELECT * FROM leads WHERE id = $1', [req.params.id]);
  if (!lead) throw new HttpError(404, 'lead_not_found');
  if (!lead.card_image_path) throw new HttpError(400, 'no_card_image');

  const buf = await readStorage(lead.card_image_path);
  if (!buf) throw new HttpError(410, 'card_image_missing');

  const ocr = await ocrCard(buf, 'card.jpg');
  if (!ocr.ok) throw new HttpError(502, 'ocr_failed', ocr.error);

  const overwrite = req.query.overwrite === 'true';
  const f = normalisePhones({ ...(ocr.fields || {}) });

  // By default only fills gaps, so a human's correction is never clobbered.
  const keep = (col, next) => (overwrite ? (next ?? lead[col]) : (lead[col] ?? next ?? null));

  const row = await one(
    `UPDATE leads SET
        ocr_engine=$2, ocr_version=$3, ocr_raw_text=$4, ocr_blocks=$5,
        ocr_confidence=$6, ocr_ms=$7, field_confidence=$8,
        full_name=$9, designation=$10, company=$11, phone_primary=$12, phone_secondary=$13,
        whatsapp=$14, email=$15, email_secondary=$16, website=$17, address=$18,
        city=$19, state=$20, pincode=$21, gstin=$22
      WHERE id=$1 RETURNING *`,
    [lead.id, ocr.engine, ocr.version, ocr.raw_text, JSON.stringify(ocr.blocks || []),
     ocr.confidence ?? null, ocr.ms ?? null, JSON.stringify(ocr.field_confidence || {}),
     keep('full_name', f.full_name), keep('designation', f.designation), keep('company', f.company),
     keep('phone_primary', f.phone_primary), keep('phone_secondary', f.phone_secondary),
     keep('whatsapp', f.whatsapp), keep('email', f.email), keep('email_secondary', f.email_secondary),
     keep('website', f.website), keep('address', f.address), keep('city', f.city),
     keep('state', f.state), keep('pincode', f.pincode), keep('gstin', f.gstin)],
  );
  res.json({ lead: row, ocr: { confidence: ocr.confidence, ms: ocr.ms } });
}));

router.delete('/:id', requireAdmin, ah(async (req, res) => {
  const row = await one('DELETE FROM leads WHERE id = $1 RETURNING id', [req.params.id]);
  if (!row) throw new HttpError(404, 'lead_not_found');
  res.json({ ok: true });
}));

/** Bulk status change from the admin list view. */
router.post('/bulk-status', requireAdmin, ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const status = clean(req.body.status);
  if (!ids.length || !status) throw new HttpError(400, 'missing_ids_or_status');
  const { rowCount } = await query(
    'UPDATE leads SET status = $1 WHERE id = ANY($2::uuid[])', [status, ids]);
  res.json({ ok: true, updated: rowCount });
}));

export default router;
