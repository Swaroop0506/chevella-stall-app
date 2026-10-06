// vCard 3.0 builder. 3.0 (not 4.0) on purpose: it is what both iOS Contacts and
// every Android contacts app import without complaint.

import { prettyIndian } from './phone.js';

function esc(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** Splits "Ravi Kumar Reddy" into vCard N: family;given;middle. */
function structuredName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0) return ';;;;';
  if (parts.length === 1) return `;${esc(parts[0])};;;`;
  const given = parts[0];
  const family = parts[parts.length - 1];
  const middle = parts.slice(1, -1).join(' ');
  return `${esc(family)};${esc(given)};${esc(middle)};;`;
}

/** Folds long lines at 75 octets per RFC 2426. */
function fold(line) {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    out.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest) out.push(' ' + rest);
  return out.join('\r\n');
}

/**
 * @param {object} c contact-shaped: {name, designation, company, phone_e164,
 *   whatsapp_e164, email, website_url, address}
 * @param {object} [opts] {minimal: true} drops everything non-essential so the
 *   payload still fits in a comfortably scannable QR.
 */
export function buildVCard(c, opts = {}) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];

  lines.push(`N:${structuredName(c.name)}`);
  lines.push(`FN:${esc(c.name)}`);
  if (c.company) lines.push(`ORG:${esc(c.company)}`);
  if (c.designation) lines.push(`TITLE:${esc(c.designation)}`);

  if (c.phone_e164) lines.push(`TEL;TYPE=CELL,VOICE:${esc(c.phone_e164)}`);
  if (c.whatsapp_e164 && c.whatsapp_e164 !== c.phone_e164) {
    lines.push(`TEL;TYPE=CELL:${esc(c.whatsapp_e164)}`);
  }
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${esc(c.email)}`);
  if (c.website_url) lines.push(`URL:${esc(c.website_url)}`);

  if (!opts.minimal) {
    if (c.address) lines.push(`ADR;TYPE=WORK:;;${esc(c.address)};;;;`);
    if (c.whatsapp_e164) {
      // Shows up as a tappable WhatsApp row in most contact apps.
      lines.push(`X-SOCIALPROFILE;TYPE=whatsapp:https://wa.me/${String(c.whatsapp_e164).replace(/\D/g, '')}`);
    }
    const noteBits = [];
    if (c.event_name) noteBits.push(`Met at ${c.event_name}`);
    if (c.whatsapp_e164) noteBits.push(`WhatsApp: ${prettyIndian(c.whatsapp_e164)}`);
    if (noteBits.length) lines.push(`NOTE:${esc(noteBits.join(' · '))}`);
    lines.push(`REV:${new Date().toISOString().replace(/\.\d{3}/, '')}`);
  }

  lines.push('END:VCARD');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Safe-ish filename for the .vcf download. */
export function vcardFilename(name) {
  const base = String(name || 'contact').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || 'contact'}.vcf`;
}
