import ExcelJS from 'exceljs';
import { readStorage } from './images.js';
import { config } from '../config.js';

const IST = 'Asia/Kolkata';

function ist(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

const COLUMNS = [
  { header: '#',              key: 'sr',           width: 6 },
  { header: 'Captured (IST)', key: 'captured_at',  width: 20 },
  { header: 'Event',          key: 'event_name',   width: 24 },
  { header: 'Captured By',    key: 'captured_by',  width: 16 },
  { header: 'Name',           key: 'full_name',    width: 24 },
  { header: 'Designation',    key: 'designation',  width: 22 },
  { header: 'Company',        key: 'company',      width: 30 },
  { header: 'Phone',          key: 'phone_primary',width: 18 },
  { header: 'Phone 2',        key: 'phone_secondary', width: 18 },
  { header: 'WhatsApp',       key: 'whatsapp',     width: 18 },
  { header: 'Email',          key: 'email',        width: 28 },
  { header: 'Website',        key: 'website',      width: 26 },
  { header: 'Address',        key: 'address',      width: 40 },
  { header: 'City',           key: 'city',         width: 16 },
  { header: 'State',          key: 'state',        width: 16 },
  { header: 'Pincode',        key: 'pincode',      width: 10 },
  { header: 'GSTIN',          key: 'gstin',        width: 18 },
  { header: 'Interest',       key: 'interest',     width: 22 },
  { header: 'Notes',          key: 'notes',        width: 36 },
  { header: 'Status',         key: 'status',       width: 12 },
  { header: 'Needs Review',   key: 'needs_review', width: 13 },
  { header: 'OCR Conf.',      key: 'ocr_confidence', width: 10 },
  { header: 'Card Photo',     key: 'card',         width: 26 },
];

const BRAND_GREEN = 'FF0B3D2E';
const BRAND_SAND = 'FFF3EDE2';

/**
 * @param {Array<object>} leads rows joined with events.name AS event_name
 * @param {object} opts {images:boolean, eventName:string}
 * @returns {Promise<Buffer>} .xlsx
 */
export async function leadsWorkbook(leads, opts = {}) {
  const withImages = Boolean(opts.images);

  const wb = new ExcelJS.Workbook();
  wb.creator = `${config.brand.company} Stall App`;
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = COLUMNS;

  const header = ws.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_GREEN } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: BRAND_GREEN } } };
  });

  for (const [i, l] of leads.entries()) {
    const row = ws.addRow({
      sr: i + 1,
      captured_at: ist(l.captured_at),
      event_name: l.event_name || '',
      captured_by: l.captured_by || '',
      full_name: l.full_name || '',
      designation: l.designation || '',
      company: l.company || '',
      phone_primary: l.phone_primary || '',
      phone_secondary: l.phone_secondary || '',
      whatsapp: l.whatsapp || '',
      email: l.email || '',
      website: l.website || '',
      address: l.address || '',
      city: l.city || '',
      state: l.state || '',
      pincode: l.pincode || '',
      gstin: l.gstin || '',
      interest: Array.isArray(l.interest_tags) ? l.interest_tags.join(', ') : '',
      notes: l.notes || '',
      status: l.status || '',
      needs_review: l.needs_review ? 'YES' : '',
      ocr_confidence: l.ocr_confidence != null ? Number(l.ocr_confidence) : '',
      card: '',
    });

    row.alignment = { vertical: 'top', wrapText: true };
    if (i % 2 === 1) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_SAND } };
      });
    }
    // Flag the rows a human still has to look at.
    if (l.needs_review) {
      row.getCell('needs_review').font = { bold: true, color: { argb: 'FFB00020' } };
    }
    row.getCell('ocr_confidence').numFmt = '0%';

    if (l.email) {
      row.getCell('email').value = { text: l.email, hyperlink: `mailto:${l.email}` };
      row.getCell('email').font = { color: { argb: 'FF0645AD' }, underline: true };
    }
    if (l.whatsapp) {
      const n = String(l.whatsapp).replace(/\D/g, '');
      row.getCell('whatsapp').value = { text: l.whatsapp, hyperlink: `https://wa.me/${n}` };
      row.getCell('whatsapp').font = { color: { argb: 'FF0645AD' }, underline: true };
    }

    if (withImages && l.card_thumb_path) {
      const buf = await readStorage(l.card_thumb_path);
      if (buf) {
        const imgId = wb.addImage({ buffer: buf, extension: 'jpeg' });
        row.height = 92;
        ws.addImage(imgId, {
          tl: { col: COLUMNS.length - 1, row: row.number - 1 },
          ext: { width: 176, height: 110 },
          editAs: 'oneCell',
        });
      }
    } else if (l.card_image_path) {
      row.getCell('card').value = {
        text: 'open photo',
        hyperlink: `${config.apiPublicUrl}/api/v1/files/${l.card_image_path}`,
      };
      row.getCell('card').font = { color: { argb: 'FF0645AD' }, underline: true };
    }
  }

  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  // ---- Summary sheet ----
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 28 }, { width: 44 }];
  const byStatus = {};
  const byStaff = {};
  for (const l of leads) {
    byStatus[l.status || 'new'] = (byStatus[l.status || 'new'] || 0) + 1;
    const k = l.captured_by || 'unknown';
    byStaff[k] = (byStaff[k] || 0) + 1;
  }
  const rows = [
    [`${config.brand.company} — Lead Export`, ''],
    ['Event', opts.eventName || 'All events'],
    ['Exported (IST)', ist(new Date())],
    ['Total leads', leads.length],
    ['Needing review', leads.filter((l) => l.needs_review).length],
    ['With phone', leads.filter((l) => l.phone_primary).length],
    ['With email', leads.filter((l) => l.email).length],
    ['', ''],
    ['By status', ''],
    ...Object.entries(byStatus).map(([k, v]) => [`  ${k}`, v]),
    ['', ''],
    ['By staff', ''],
    ...Object.entries(byStaff).sort((a, b) => b[1] - a[1]).map(([k, v]) => [`  ${k}`, v]),
  ];
  rows.forEach((r) => sum.addRow(r));
  sum.getRow(1).font = { bold: true, size: 14, color: { argb: BRAND_GREEN } };
  [9, 12 + Object.keys(byStatus).length].forEach((n) => {
    const r = sum.getRow(n);
    if (r) r.font = { bold: true };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function exportFilename(eventName) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const ev = String(eventName || 'all-events').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `chevella-leads-${ev}-${stamp}.xlsx`;
}
