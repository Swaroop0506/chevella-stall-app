import PDFDocument from 'pdfkit';
import { qrPng } from './qr.js';
import { prettyIndian } from './phone.js';
import { config } from '../config.js';

const GREEN = '#0B3D2E';
const LEAF = '#2E7D52';
const SAND = '#F3EDE2';
const INK = '#1A1A1A';
const MUTED = '#6B6B6B';

const A4 = { w: 595.28, h: 841.89 };

/**
 * Collects the PDF stream into a Buffer.
 *
 * Note it does NOT call doc.end() — the caller must, once every page has been written.
 * Ending the document here would race the async page builders (each of which awaits QR
 * rendering) and emit a near-empty one-page PDF.
 */
function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/**
 * Print pack for a stall.
 *
 * mode 'poster' — one A4 per contact, QR at 260 pt (≈9 cm). Scans from ~1 m, which is
 *                 the distance someone stands at the far side of a counter.
 * mode 'tent'   — four table-tent cards per A4 with cut guides, QR at 150 pt (≈5 cm).
 *
 * @param {object} event
 * @param {Array<object>} contacts rows from event_contacts, each with a `url`
 * @param {object} opts {mode:'poster'|'tent', websiteUrl:string}
 */
export async function buildPrintPack(event, contacts, opts = {}) {
  const mode = opts.mode === 'tent' ? 'tent' : 'poster';
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false,
    info: { Title: `${config.brand.company} — ${event.name} QR pack`, Author: config.brand.company } });
  const out = streamToBuffer(doc);

  // Website QR always leads the pack — it is the one QR that goes on the backdrop.
  const siteUrl = opts.websiteUrl || event.website_url || config.brand.website;
  await websitePage(doc, siteUrl);

  if (mode === 'poster') {
    for (const c of contacts) await posterPage(doc, event, c);
  } else {
    for (let i = 0; i < contacts.length; i += 4) {
      await tentPage(doc, event, contacts.slice(i, i + 4));
    }
  }

  doc.end();   // only now — every page is on the stream
  return out;
}

// ---------------------------------------------------------------- shared chrome

function header(doc, subtitle) {
  doc.rect(0, 0, A4.w, 104).fill(GREEN);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(26)
     .text(config.brand.company, 0, 32, { width: A4.w, align: 'center' });
  doc.font('Helvetica-Oblique').fontSize(11).fillColor('#CFE3D7')
     .text(subtitle || config.brand.tagline, 0, 66, { width: A4.w, align: 'center' });
}

function footer(doc) {
  const y = A4.h - 58;
  doc.rect(0, y, A4.w, 58).fill(SAND);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
     .text(`${config.brand.legalName}  ·  ${config.brand.website.replace(/^https?:\/\//, '')}  ·  ${prettyIndian(config.brand.phone)}`,
           0, y + 14, { width: A4.w, align: 'center' })
     .text(config.brand.address, 0, y + 28, { width: A4.w, align: 'center' });
}

async function qrBlock(doc, text, x, y, size) {
  const png = await qrPng(text, { size: Math.max(600, size * 3) });
  // white plate behind the code so it still scans on a coloured background
  doc.roundedRect(x - 12, y - 12, size + 24, size + 24, 10).fill('#FFFFFF');
  doc.image(png, x, y, { width: size, height: size });
}

// ---------------------------------------------------------------- pages

async function websitePage(doc, url) {
  doc.addPage();
  header(doc, config.brand.tagline);

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(30)
     .text('SCAN TO VISIT', 0, 160, { width: A4.w, align: 'center' });
  doc.fillColor(LEAF).fontSize(30)
     .text('OUR WEBSITE', 0, 196, { width: A4.w, align: 'center' });

  const size = 260;
  await qrBlock(doc, url, (A4.w - size) / 2, 260, size);

  doc.fillColor(INK).font('Helvetica').fontSize(13)
     .text(url.replace(/^https?:\/\//, '').replace(/\/$/, ''), 0, 560, { width: A4.w, align: 'center' });

  doc.fillColor(MUTED).fontSize(11)
     .text('Instant coconut water powder  ·  Tender coconut water  ·  100% vegan',
           60, 600, { width: A4.w - 120, align: 'center' });

  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9)
     .text('Point your phone camera at the code — no app needed.', 0, 640, { width: A4.w, align: 'center' });

  footer(doc);
}

async function posterPage(doc, event, c) {
  doc.addPage();
  header(doc, event.name);

  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(27)
     .text('SCAN HERE TO SAVE', 0, 142, { width: A4.w, align: 'center' });
  doc.fillColor(LEAF).fontSize(27)
     .text('OUR CONTACT', 0, 176, { width: A4.w, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(12)
     .text('…and WhatsApp us straight away', 0, 212, { width: A4.w, align: 'center' });

  const size = 250;
  await qrBlock(doc, c.url, (A4.w - size) / 2, 244, size);

  // name plate
  const py = 528;
  doc.roundedRect(70, py, A4.w - 140, 108, 12).fill(SAND);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(21)
     .text(c.name, 86, py + 16, { width: A4.w - 172, align: 'center' });
  if (c.designation) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(11.5)
       .text(c.designation, 86, py + 44, { width: A4.w - 172, align: 'center' });
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16)
     .text(prettyIndian(c.phone_e164), 86, py + 68, { width: A4.w - 172, align: 'center' });

  // three-step instruction strip
  const steps = [
    ['1', 'Open your phone camera'],
    ['2', 'Point it at the QR code'],
    ['3', 'Tap Save contact'],
  ];
  const sy = 664;
  const colW = (A4.w - 120) / 3;
  steps.forEach(([n, label], i) => {
    const cx = 60 + colW * i + colW / 2;
    doc.circle(cx, sy + 11, 11).fill(LEAF);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
       .text(n, cx - 11, sy + 6, { width: 22, align: 'center' });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
       .text(label, 60 + colW * i, sy + 30, { width: colW, align: 'center' });
  });

  if (event.stall_no || event.venue) {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9)
       .text([event.venue, event.stall_no && `Stall ${event.stall_no}`].filter(Boolean).join(' · '),
             0, 742, { width: A4.w, align: 'center' });
  }

  footer(doc);
}

async function tentPage(doc, event, group) {
  doc.addPage();
  const cellW = A4.w / 2;
  const cellH = A4.h / 2;

  // cut guides
  doc.save().lineWidth(0.5).dash(4, { space: 4 }).strokeColor('#C9C9C9');
  doc.moveTo(cellW, 0).lineTo(cellW, A4.h).stroke();
  doc.moveTo(0, cellH).lineTo(A4.w, cellH).stroke();
  doc.restore();

  for (const [i, c] of group.entries()) {
    const ox = (i % 2) * cellW;
    const oy = Math.floor(i / 2) * cellH;

    doc.roundedRect(ox + 16, oy + 16, cellW - 32, cellH - 32, 10).fill(SAND);
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(13)
       .text(config.brand.company, ox + 24, oy + 34, { width: cellW - 48, align: 'center' });
    doc.fillColor(LEAF).font('Helvetica-Bold').fontSize(11.5)
       .text('SCAN TO SAVE OUR CONTACT', ox + 24, oy + 54, { width: cellW - 48, align: 'center' });

    const size = 148;
    await qrBlock(doc, c.url, ox + (cellW - size) / 2, oy + 82, size);

    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(13)
       .text(c.name, ox + 24, oy + 262, { width: cellW - 48, align: 'center' });
    if (c.designation) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
         .text(c.designation, ox + 24, oy + 280, { width: cellW - 48, align: 'center' });
    }
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11)
       .text(prettyIndian(c.phone_e164), ox + 24, oy + 296, { width: cellW - 48, align: 'center' });
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7.5)
       .text(`${event.name}  ·  WhatsApp us from the same screen`,
             ox + 24, oy + 318, { width: cellW - 48, align: 'center' });
  }
}
