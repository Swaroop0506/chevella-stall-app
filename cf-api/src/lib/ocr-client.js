import { config } from '../config.js';

/**
 * Calls cf-ocr. Never throws: a lead must always save, even if OCR is down or slow —
 * the card photo is the ground truth and the fields can be filled in later from the admin.
 *
 * @returns {{ok:boolean, error?:string, engine?:string, version?:string, raw_text?:string,
 *            blocks?:Array, confidence?:number, ms?:number, fields?:object,
 *            field_confidence?:object}}
 */
export async function ocrCard(buffer, filename = 'card.jpg') {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.ocrTimeoutMs);

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename);

    const res = await fetch(`${config.ocrUrl}/v1/card`, {
      method: 'POST',
      body: form,
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `OCR ${res.status}: ${body.slice(0, 300)}`, ms: Date.now() - started };
    }

    const json = await res.json();
    return { ok: true, ...json, ms: json.ms ?? Date.now() - started };
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? `OCR timed out after ${config.ocrTimeoutMs} ms`
      : `OCR unreachable: ${err.message}`;
    return { ok: false, error: msg, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function ocrHealth() {
  try {
    const res = await fetch(`${config.ocrUrl}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
