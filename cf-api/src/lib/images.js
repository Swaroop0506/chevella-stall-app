import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { paths } from '../config.js';

/**
 * Normalises an uploaded card photo and writes two derivatives.
 *
 * `card`  — what the OCR service reads and what admins zoom into. Capped at 2400 px on the
 *           long edge: beyond that RapidOCR gains nothing and the upload storage doubles.
 * `thumb` — 480 px, for list rows and the Excel export's embedded image column.
 *
 * @returns {{cardPath:string, thumbPath:string, width:number, height:number, bytes:number}}
 *          paths are storage-relative, e.g. "cards/2026-10/ab12….jpg"
 */
export async function storeCardImage(buffer, { subdir = 'cards' } = {}) {
  const month = new Date().toISOString().slice(0, 7); // 2026-10
  const id = crypto.randomUUID();

  const base = sharp(buffer, { failOn: 'none' }).rotate(); // rotate() applies the EXIF orientation
  const meta = await base.metadata();

  const cardRel = path.join(subdir, month, `${id}.jpg`);
  const thumbRel = path.join('thumbs', month, `${id}.jpg`);
  const cardAbs = path.join(paths.root, 'storage', cardRel);
  const thumbAbs = path.join(paths.root, 'storage', thumbRel);

  await fs.mkdir(path.dirname(cardAbs), { recursive: true });
  await fs.mkdir(path.dirname(thumbAbs), { recursive: true });

  const cardBuf = await base
    .clone()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  const thumbBuf = await base
    .clone()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();

  await fs.writeFile(cardAbs, cardBuf);
  await fs.writeFile(thumbAbs, thumbBuf);

  return {
    cardPath: cardRel.split(path.sep).join('/'),
    thumbPath: thumbRel.split(path.sep).join('/'),
    width: meta.width || 0,
    height: meta.height || 0,
    bytes: cardBuf.length,
    ocrBuffer: cardBuf,
  };
}

export function storageAbs(relPath) {
  // Reject traversal before touching the filesystem.
  const clean = String(relPath || '').replace(/\\/g, '/');
  if (!clean || clean.includes('..') || clean.startsWith('/')) return null;
  return path.join(paths.root, 'storage', clean);
}

export async function readStorage(relPath) {
  const abs = storageAbs(relPath);
  if (!abs) return null;
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}
