// Applies every .sql file in ../migrations in filename order, once each.
import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { pool, query, one } from './db.js';
import { config, paths } from './config.js';

const migrationsDir = path.join(paths.root, 'migrations');

async function ensureLedger() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function run() {
  // storage dirs must exist before the first upload
  await Promise.all(
    [paths.cards, paths.thumbs, paths.qr].map((d) => fs.mkdir(d, { recursive: true })),
  );

  await ensureLedger();

  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
  );

  for (const file of files) {
    if (done.has(file)) {
      console.log(`[migrate] skip   ${file}`);
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED  ${file}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  await seedAdmin();
  console.log('[migrate] done');
}

async function seedAdmin() {
  const { email, password, name } = config.seedAdmin;
  if (!password) {
    const count = await one('SELECT count(*)::int AS n FROM admins');
    if (count.n === 0) {
      console.warn(
        '[migrate] no admins exist and SEED_ADMIN_PASSWORD is unset — ' +
        'set it in .env and re-run `npm run migrate` to create the first login.',
      );
    }
    return;
  }
  const existing = await one('SELECT id FROM admins WHERE email = $1', [email.toLowerCase()]);
  if (existing) {
    console.log(`[migrate] admin ${email} already exists — leaving its password alone`);
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await query(
    'INSERT INTO admins (name, email, password_hash) VALUES ($1, $2, $3)',
    [name, email.toLowerCase(), hash],
  );
  console.log(`[migrate] created admin ${email}`);
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
