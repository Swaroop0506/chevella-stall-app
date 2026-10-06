import multer from 'multer';
import crypto from 'node:crypto';
import { config } from '../config.js';

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export const cardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 2 },
  fileFilter(_req, file, cb) {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new HttpError(400, 'unsupported_image_type', `Got ${file.mimetype}; send JPEG, PNG, WebP or HEIC.`));
  },
});

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function notFound(_req, res) {
  res.status(404).json({ error: 'not_found' });
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof multer.MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_error';
    return res.status(400).json({ error: code, detail: err.message });
  }
  if (err?.status) {
    return res.status(err.status).json({ error: err.code || 'error', detail: err.message });
  }
  // Map the Postgres integrity codes we actually hit to clean 4xx responses.
  switch (err?.code) {
    case '23505': return res.status(409).json({ error: 'conflict', detail: err.detail });
    case '23503': return res.status(400).json({ error: 'bad_reference', detail: err.detail });
    case '23502': return res.status(400).json({ error: 'missing_field', detail: err.column });
    case '23514': return res.status(400).json({ error: 'invalid_value', detail: err.constraint });
    case '22P02': return res.status(400).json({ error: 'bad_uuid' });
    default: break;
  }

  console.error('[error]', err);
  return res.status(500).json({ error: 'internal_error' });
}

export function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '') + config.ipHashSalt).digest('hex');
}

/** Trims strings, turns '' into null, leaves everything else alone. */
export function clean(v) {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function pick(body, keys) {
  const out = {};
  for (const k of keys) if (k in body) out[k] = clean(body[k]);
  return out;
}
