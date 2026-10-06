import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name} — copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),

  databaseUrl: required('DATABASE_URL', 'postgres://cf:cf@localhost:5432/chevella_stall'),

  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  jwtTtl: process.env.JWT_TTL || '30d',

  // Shared key the mobile app sends as x-api-key. The app needs no user login, but this
  // keeps the capture endpoints from being an open write surface on the public internet.
  deviceApiKey: required('DEVICE_API_KEY', 'dev-device-key-change-me'),

  // Public origin of cf-admin — this is what goes inside the contact QR codes.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  // Where this API is reachable from the phones (used only in printed setup docs).
  apiPublicUrl: (process.env.API_PUBLIC_URL || 'http://localhost:4000').replace(/\/+$/, ''),

  ocrUrl: (process.env.OCR_URL || 'http://localhost:8000').replace(/\/+$/, ''),
  ocrTimeoutMs: Number(process.env.OCR_TIMEOUT_MS || 60000),

  storageDir: process.env.STORAGE_DIR || path.join(root, 'storage'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 12),

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',').map((s) => s.trim()).filter(Boolean),

  ipHashSalt: process.env.IP_HASH_SALT || 'chevella-salt',

  brand: {
    company: process.env.BRAND_COMPANY || 'Chevella Farms',
    legalName: process.env.BRAND_LEGAL_NAME || 'Frister Foods Pvt Ltd',
    tagline: process.env.BRAND_TAGLINE || 'The land of coconut goodness',
    website: process.env.BRAND_WEBSITE || 'https://www.chevellafarms.com/',
    phone: process.env.BRAND_PHONE || '+919701221934',
    email: process.env.BRAND_EMAIL || 'info@fristerfoods.com',
    address: process.env.BRAND_ADDRESS ||
      '701 Babu Khan Millennium Center, Somajiguda, Hyderabad 500082, Telangana, India',
  },

  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Chevella Admin',
    email: process.env.SEED_ADMIN_EMAIL || 'admin@chevellafarms.com',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },
};

export const paths = {
  root,
  cards: path.join(config.storageDir, 'cards'),
  thumbs: path.join(config.storageDir, 'thumbs'),
  qr: path.join(config.storageDir, 'qr'),
};
