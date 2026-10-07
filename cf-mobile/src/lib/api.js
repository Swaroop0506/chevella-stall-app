import { getSettings } from './store';

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function base() {
  const s = await getSettings();
  if (!s.apiUrl) throw new ApiError(0, 'not_configured', 'Set the API URL in Setup first.');
  return s;
}

async function call(method, path, { json, form, timeoutMs = 25000 } = {}) {
  const s = await base();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const headers = { 'x-api-key': s.deviceKey, accept: 'application/json' };
  let body;
  if (form) {
    body = form;                                  // RN sets the multipart boundary itself
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  try {
    const res = await fetch(`${s.apiUrl}/api/v1${path}`, {
      method, headers, body, signal: ctrl.signal,
    });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiError(res.status, data?.error, data?.detail || txt?.slice(0, 180));
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError(0, 'timeout', 'The server took too long to answer.');
    throw new ApiError(0, 'offline', 'No connection to the server.');
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  handshake: () => call('GET', '/app/handshake', { timeoutMs: 12000 }),
  events: () => call('GET', '/app/events', { timeoutMs: 12000 }),
  summary: (eventId, capturedBy) =>
    call('GET', `/app/events/${eventId}/summary?captured_by=${encodeURIComponent(capturedBy || '')}`),
  reconcile: (captureIds) => call('POST', '/app/reconcile', { json: { capture_ids: captureIds } }),
  patchLead: (id, fields) => call('PATCH', `/leads/${id}`, { json: fields }),

  /** Attaches the back of a card to a lead the server already has. */
  async uploadBack(leadId, uri, name) {
    const form = new FormData();
    form.append('card_back', { uri, name: `${name}-back.jpg`, type: 'image/jpeg' });
    return call('POST', `/leads/${leadId}/back`, { form, timeoutMs: 90000 });
  },

  /**
   * Uploads one card. OCR runs server-side, so this can take a while on a weak CPU —
   * hence the long timeout. The caller's queue handles the failure case.
   */
  async uploadCard({ uri, backUri, eventId, captureId, capturedBy, deviceLabel, capturedAt, notes, tags }) {
    const form = new FormData();
    // React Native's FormData takes this {uri, name, type} shape rather than a Blob.
    form.append('card', { uri, name: `${captureId}.jpg`, type: 'image/jpeg' });
    if (backUri) {
      form.append('card_back', { uri: backUri, name: `${captureId}-back.jpg`, type: 'image/jpeg' });
    }
    form.append('event_id', eventId);
    form.append('client_capture_id', captureId);
    if (capturedBy) form.append('captured_by', capturedBy);
    if (deviceLabel) form.append('device_label', deviceLabel);
    if (capturedAt) form.append('captured_at', capturedAt);
    if (notes) form.append('notes', notes);
    if (tags?.length) form.append('interest_tags', tags.join(','));
    return call('POST', '/leads', { form, timeoutMs: 90000 });
  },
};

export function friendly(err) {
  const map = {
    bad_device_key: 'This phone\'s device key is wrong. Fix it in Setup.',
    not_configured: 'Finish Setup before scanning.',
    offline: 'No connection — the card is saved on this phone and will upload automatically.',
    timeout: 'The server is slow to answer. The card is queued and will retry.',
    event_not_found: 'That event no longer exists on the server. Pick another in Setup.',
    file_too_large: 'That photo is too large. Try again a little further from the card.',
  };
  return map[err?.code] || err?.message || 'Something went wrong.';
}
