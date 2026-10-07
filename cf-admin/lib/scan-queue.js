'use client';

/**
 * Offline-first capture queue for the web scanner.
 *
 * Same contract as the Android app's queue (cf-mobile/src/lib/queue.js) — capture now,
 * upload later, idempotent on a client-generated id — but backed by IndexedDB because
 * that is the only browser store that holds a multi-megabyte Blob reliably. localStorage
 * would need base64, inflating every photo by a third and blowing the 5 MB quota after
 * about four cards.
 *
 * The honest limitation versus the native app: a browser only runs while its tab is
 * alive. The queue drains on an interval, when the tab regains focus, and when the
 * network comes back — but if staff close the tab with uploads pending, those uploads
 * resume the next time they open it, not before. The UI says so rather than pretending
 * otherwise.
 */

const DB_NAME = 'cf-scan';
const DB_VERSION = 1;
const STORE = 'captures';
const SETTINGS_KEY = 'cf.scan.settings.v1';

const BACKOFF_S = [0, 5, 15, 45, 120, 300, 600];

let listeners = new Set();
let flushing = false;

// ----------------------------------------------------------------- settings

const DEFAULTS = {
  deviceKey: '',
  staffName: '',
  deviceLabel: '',
  eventId: '',
  eventName: '',
  interestTags: [],
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Private mode with storage blocked — the session still works, it just forgets.
  }
  return next;
}

export function isConfigured(s = getSettings()) {
  return Boolean(s.deviceKey && s.staffName && s.eventId);
}

// ----------------------------------------------------------------- indexeddb

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('status', 'status');
        store.createIndex('capturedAt', 'capturedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let out;
      try {
        out = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listQueue() {
  const db = await openDb();
  try {
    const items = await reqToPromise(db.transaction(STORE).objectStore(STORE).getAll());
    return items.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  } finally {
    db.close();
  }
}

async function getOne(id) {
  const db = await openDb();
  try {
    return await reqToPromise(db.transaction(STORE).objectStore(STORE).get(id));
  } finally {
    db.close();
  }
}

async function put(record) {
  await withStore('readwrite', (store) => store.put(record));
  await emit();
  return record;
}

async function patch(id, changes) {
  const current = await getOne(id);
  if (!current) return null;
  return put({ ...current, ...changes });
}

export async function removeItem(id) {
  await withStore('readwrite', (store) => store.delete(id));
  await emit();
}

// ----------------------------------------------------------------- events

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function emit() {
  const items = await listQueue();
  for (const fn of listeners) {
    try { fn(items); } catch { /* a bad listener must not break the queue */ }
  }
}

// ----------------------------------------------------------------- capture

function captureId() {
  const rand = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  return `w${Date.now().toString(36)}-${rand.slice(0, 10)}`;
}

/**
 * Normalises a captured frame or picked file down to something worth uploading.
 *
 * 2200 px on the long edge at quality 0.82 matches the Android app exactly, so a card
 * scanned on a phone browser and the same card scanned in the APK reach the OCR service
 * at identical dimensions and produce identical results.
 */
export async function prepareImage(source) {
  const bitmap = await createImageBitmap(source);
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = long > 2200 ? 2200 / long : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.82));

  return { blob, width: w, height: h };
}

export async function enqueueCapture(blob, { notes = '', tags = [] } = {}) {
  const s = getSettings();
  const record = {
    id: captureId(),
    blob,
    eventId: s.eventId,
    eventName: s.eventName,
    capturedBy: s.staffName,
    deviceLabel: s.deviceLabel || 'Web scanner',
    capturedAt: new Date().toISOString(),
    notes,
    tags,
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    leadId: null,
    fields: null,
    needsReview: null,
    duplicateOf: null,
  };
  await put(record);
  flush().catch(() => {});
  return record;
}

export async function annotate(id, { notes, tags }) {
  const item = await getOne(id);
  if (!item) return null;

  const changes = {};
  if (notes !== undefined) changes.notes = notes;
  if (tags !== undefined) changes.tags = tags;

  if (item.status === 'done' && item.leadId) {
    try {
      await apiPatchLead(item.leadId, {
        notes: changes.notes ?? item.notes,
        interest_tags: changes.tags ?? item.tags,
        // The browser has not compared the photo against the fields, so it must not
        // claim the lead was reviewed.
        needs_review: item.needsReview !== false,
      });
    } catch {
      changes.annotationPending = true;
    }
  }
  return patch(id, changes);
}

// ----------------------------------------------------------------- network

function authHeaders() {
  return { 'x-api-key': getSettings().deviceKey };
}

async function apiGet(path, timeoutMs = 12000) {
  const res = await fetch(`/api/v1${path}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function apiPatchLead(id, body) {
  const res = await fetch(`/api/v1/leads/${id}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const scanApi = {
  handshake: () => apiGet('/app/handshake'),
  events: () => apiGet('/app/events'),
  summary: (eventId, by) =>
    apiGet(`/app/events/${eventId}/summary?captured_by=${encodeURIComponent(by || '')}`),
};

async function reconcile(ids) {
  const res = await fetch('/api/v1/app/reconcile', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture_ids: ids }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function upload(item) {
  const form = new FormData();
  form.append('card', item.blob, `${item.id}.jpg`);
  form.append('event_id', item.eventId);
  form.append('client_capture_id', item.id);
  if (item.capturedBy) form.append('captured_by', item.capturedBy);
  if (item.deviceLabel) form.append('device_label', item.deviceLabel);
  if (item.capturedAt) form.append('captured_at', item.capturedAt);
  if (item.notes) form.append('notes', item.notes);
  if (item.tags?.length) form.append('interest_tags', item.tags.join(','));

  const res = await fetch('/api/v1/leads', {
    method: 'POST',
    headers: authHeaders(),
    body: form,
    // OCR reads each card six ways, so allow generously before giving up.
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    let code = `http_${res.status}`;
    try { code = (await res.json())?.error || code; } catch { /* non-JSON */ }
    throw Object.assign(new Error(code), { code, status: res.status });
  }
  return res.json();
}

// ----------------------------------------------------------------- flush

function dueForRetry(item) {
  if (item.status === 'done' || item.status === 'uploading') return false;
  if (!item.lastAttemptAt) return true;
  const wait = BACKOFF_S[Math.min(item.attempts, BACKOFF_S.length - 1)] * 1000;
  return Date.now() - new Date(item.lastAttemptAt).getTime() >= wait;
}

export async function flush({ force = false } = {}) {
  if (flushing) return { skipped: true };
  if (!isConfigured()) return { notConfigured: true };
  if (typeof navigator !== 'undefined' && navigator.onLine === false && !force) {
    return { offline: true };
  }

  flushing = true;
  try {
    const all = await listQueue();
    const candidates = all.filter((it) =>
      it.status !== 'done' && (force || dueForRetry(it)));
    if (!candidates.length) return { nothing: true };

    // A connection that dropped *after* a successful upload would otherwise cost the
    // bandwidth twice. Ask what the server already holds first.
    try {
      const { known } = await reconcile(candidates.map((it) => it.id));
      for (const id of known || []) {
        await patch(id, { status: 'done', lastError: null, blob: undefined });
      }
    } catch {
      // Optimisation only.
    }

    let uploaded = 0;
    let failed = 0;

    for (const item of await listQueue()) {
      if (item.status === 'done') continue;
      await patch(item.id, { status: 'uploading', lastAttemptAt: new Date().toISOString() });
      try {
        const res = await upload(item);
        const lead = res.lead || {};
        await patch(item.id, {
          status: 'done',
          leadId: lead.id || null,
          needsReview: lead.needs_review ?? null,
          duplicateOf: res.possible_duplicate?.full_name || null,
          fields: {
            full_name: lead.full_name,
            company: lead.company,
            designation: lead.designation,
            phone_primary: lead.phone_primary,
            email: lead.email,
            city: lead.city,
          },
          lastError: null,
          attempts: item.attempts + 1,
          // Drop the Blob once the server has it; browser storage quotas are tight.
          blob: undefined,
        });
        uploaded++;
      } catch (err) {
        failed++;
        await patch(item.id, {
          status: 'pending',
          attempts: item.attempts + 1,
          lastError: err?.code || err?.name || 'upload_failed',
        });
        // A dead network fails every remaining item identically; stop early.
        if (err?.name === 'TimeoutError' || err?.name === 'TypeError') break;
      }
    }

    return { uploaded, failed };
  } finally {
    flushing = false;
    await emit();
  }
}

export async function counts() {
  const items = await listQueue();
  const istDay = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const today = istDay(Date.now());
  return {
    total: items.length,
    pending: items.filter((i) => i.status !== 'done').length,
    done: items.filter((i) => i.status === 'done').length,
    needsReview: items.filter((i) => i.needsReview).length,
    today: items.filter((i) => istDay(i.capturedAt) === today).length,
  };
}

/** Clears uploaded entries older than a day so the history list stays readable. */
export async function pruneDone({ olderThanHours = 24 } = {}) {
  const cutoff = Date.now() - olderThanHours * 3600_000;
  const items = await listQueue();
  let removed = 0;
  for (const it of items) {
    if (it.status === 'done' && new Date(it.capturedAt).getTime() < cutoff) {
      await withStore('readwrite', (store) => store.delete(it.id));
      removed++;
    }
  }
  if (removed) await emit();
  return removed;
}
