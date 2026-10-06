// Phone normalisation to E.164, defaulting to India (+91).
// Deliberately dependency-free: libphonenumber is overkill for a single-country stall tool
// and its metadata is ~500 kB. The rules below cover Indian mobile + landline + pasted
// international numbers, which is everything a visiting card at an Indian expo will carry.

const DEFAULT_CC = '91';

/** Strips everything that is not a digit or a leading +. */
function clean(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // common OCR / typing noise
  s = s.replace(/[‐-―−]/g, '-')   // unicode dashes -> hyphen
       .replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0')  // O mistaken for 0 inside digit runs
       .replace(/\b[lI](?=\d)/g, '1');
  const plus = s.startsWith('+') || /^00\d/.test(s);
  const digits = s.replace(/\D/g, '').replace(/^00/, '');
  return (plus ? '+' : '') + digits;
}

/**
 * @returns {string|null} E.164 like "+919701221934", or null when it cannot be a real number.
 */
export function toE164(raw, defaultCc = DEFAULT_CC) {
  const s = clean(raw);
  if (!s) return null;
  const hasPlus = s.startsWith('+');
  let d = hasPlus ? s.slice(1) : s;

  if (hasPlus) {
    if (d.length < 8 || d.length > 15) return null;
    return `+${d}`;
  }

  // Indian trunk prefix: 09701221934 -> 9701221934
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  // Country code typed without a plus: 919701221934
  if (d.length === 12 && d.startsWith(defaultCc)) return `+${d}`;
  if (d.length === 13 && d.startsWith('0' + defaultCc)) return `+${d.slice(1)}`;

  // 10-digit Indian subscriber number (mobiles start 6-9; landlines with STD also land here)
  if (d.length === 10) return `+${defaultCc}${d}`;

  // Landline written as STD + number without the leading 0, e.g. 4023456789 (handled above)
  // or 8-9 digits where the STD code was omitted entirely — not resolvable, keep raw.
  if (d.length >= 8 && d.length <= 15) return `+${defaultCc}${d}`;

  return null;
}

/** True for an Indian mobile (the only numbers WhatsApp will reach). */
export function isIndianMobile(e164) {
  return /^\+91[6-9]\d{9}$/.test(e164 || '');
}

/** "+919701221934" -> "+91 97012 21934" for display. */
export function prettyIndian(e164) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164 || '');
  return m ? `+91 ${m[1]} ${m[2]}` : e164 || '';
}

/** Digits only, for wa.me links. */
export function waDigits(e164) {
  return String(e164 || '').replace(/\D/g, '');
}

/** Builds the WhatsApp deep link. Works on phone and desktop, no API needed. */
export function waLink(e164, prefill) {
  const n = waDigits(e164);
  if (!n) return null;
  const q = prefill ? `?text=${encodeURIComponent(prefill)}` : '';
  return `https://wa.me/${n}${q}`;
}
