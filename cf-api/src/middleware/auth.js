import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const COOKIE = 'cf_session';

export function signSession(admin) {
  return jwt.sign(
    { sub: admin.id, email: admin.email, name: admin.name },
    config.jwtSecret,
    { expiresIn: config.jwtTtl },
  );
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

/** Admin-only routes. Accepts the session cookie or an Authorization: Bearer header. */
export function requireAdmin(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = req.cookies?.[COOKIE] || bearer;
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    req.admin = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'session_expired' });
  }
}

/**
 * Capture endpoints used by the phones. There is no user login by design — the staff
 * at the stall should never be typing a password — so the app ships a shared key instead.
 * It stops drive-by writes; it is not a per-user identity.
 */
export function requireDeviceKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || String(key) !== config.deviceApiKey) {
    return res.status(401).json({ error: 'bad_device_key' });
  }
  return next();
}

/** Allows either an admin session or a device key — used by read endpoints both need. */
export function requireAdminOrDevice(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key && String(key) === config.deviceApiKey) return next();
  return requireAdmin(req, res, next);
}
