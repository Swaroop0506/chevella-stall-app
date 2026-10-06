import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { one, query } from '../db.js';
import { ah, HttpError, clean } from '../middleware/common.js';
import { COOKIE, signSession, cookieOptions, requireAdmin } from '../middleware/auth.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

router.post('/login', loginLimiter, ah(async (req, res) => {
  const email = (clean(req.body.email) || '').toLowerCase();
  const password = req.body.password || '';
  if (!email || !password) throw new HttpError(400, 'missing_credentials');

  const admin = await one(
    'SELECT id, name, email, password_hash, is_active FROM admins WHERE email = $1',
    [email],
  );

  // Same response and roughly the same timing whether or not the email exists.
  const hash = admin?.password_hash || '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = await bcrypt.compare(password, hash);

  if (!admin || !admin.is_active || !ok) throw new HttpError(401, 'invalid_credentials');

  await query('UPDATE admins SET last_login_at = now() WHERE id = $1', [admin.id]);

  res.cookie(COOKIE, signSession(admin), cookieOptions());
  res.json({ admin: { id: admin.id, name: admin.name, email: admin.email } });
}));

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAdmin, ah(async (req, res) => {
  const admin = await one('SELECT id, name, email, last_login_at FROM admins WHERE id = $1', [req.admin.sub]);
  if (!admin) throw new HttpError(401, 'session_expired');
  res.json({ admin });
}));

router.post('/change-password', requireAdmin, ah(async (req, res) => {
  const current = req.body.current_password || '';
  const next = req.body.new_password || '';
  if (next.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters.');

  const admin = await one('SELECT id, password_hash FROM admins WHERE id = $1', [req.admin.sub]);
  if (!admin || !(await bcrypt.compare(current, admin.password_hash))) {
    throw new HttpError(401, 'invalid_credentials');
  }
  await query('UPDATE admins SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(next, 12), admin.id]);
  res.json({ ok: true });
}));

export default router;
