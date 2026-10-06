import QRCode from 'qrcode';
import crypto from 'node:crypto';

// Unambiguous alphabet — no 0/O, 1/l/I — so a code can be read off a printed sheet
// and typed back without guessing.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** Short, URL-safe, collision-checked by the caller against event_contacts.code. */
export function shortCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function slugify(s, max = 80) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'untitled';
}

const BASE_OPTS = {
  // Level Q survives a thumbprint, a crease and a slightly glossy print, which is
  // what actually happens to a QR taped to a stall counter.
  errorCorrectionLevel: 'Q',
  margin: 2,
  color: { dark: '#0B3D2E', light: '#FFFFFF' },
};

/** @returns {Promise<Buffer>} PNG */
export function qrPng(text, { size = 1024, dark, light } = {}) {
  return QRCode.toBuffer(text, {
    ...BASE_OPTS,
    type: 'png',
    width: size,
    color: { dark: dark || BASE_OPTS.color.dark, light: light || BASE_OPTS.color.light },
  });
}

/** @returns {Promise<string>} SVG markup — use this for print, it stays crisp at any size. */
export function qrSvg(text, { dark, light } = {}) {
  return QRCode.toString(text, {
    ...BASE_OPTS,
    type: 'svg',
    color: { dark: dark || BASE_OPTS.color.dark, light: light || BASE_OPTS.color.light },
  });
}

/** @returns {Promise<string>} data: URI, for embedding straight into HTML/PDF. */
export function qrDataUrl(text, { size = 512 } = {}) {
  return QRCode.toDataURL(text, { ...BASE_OPTS, width: size });
}

/**
 * A vCard can overflow a QR that still scans reliably from 30 cm on a cheap phone.
 * Version 15 at level Q holds ~520 alphanumeric chars; past that we tell the caller
 * to fall back to the landing-page QR instead of silently printing an unscannable block.
 */
export const VCARD_QR_SAFE_BYTES = 520;

export function vcardFitsInQr(vcard) {
  return Buffer.byteLength(vcard, 'utf8') <= VCARD_QR_SAFE_BYTES;
}
