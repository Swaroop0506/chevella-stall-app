// Offline-first capture queue.
//
// Exhibition wifi is unreliable and mobile data inside a steel hall is worse. The app
// therefore never blocks on the network: a photo is copied into the app's own storage and
// recorded in the queue the moment the shutter fires, and uploading happens afterwards,
// whenever there is signal. A phone can take a hundred cards with no connection at all and
// sync them on the drive home.
//
// Every entry carries a client-generated capture id which the API treats as an idempotency
// key, so retrying blind can never create a duplicate lead.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Network from 'expo-network';

import { api } from './api';
import { getSettings } from './store';

const QUEUE_KEY = 'cf.queue.v1';
const CARD_DIR = `${FileSystem.documentDirectory}cards/`;

// Retry backoff by attempt count, in seconds. Caps out rather than growing forever: the
// user may walk into signal at any moment and should not wait an hour for the next try.
const BACKOFF = [0, 5, 15, 45, 120, 300, 600];

let listeners = new Set();
let flushing = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function emit() {
  const items = await readQueue();
  for (const fn of listeners) {
    try { fn(items); } catch { /* a bad listener must not break the queue */ }
  }
}

// ----------------------------------------------------------------- storage

async function readQueue() {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeQueue(items) {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

async function update(id, patch) {
  const items = await readQueue();
  const next = items.map((it) => (it.id === id ? { ...it, ...patch } : it));
  await writeQueue(next);
  await emit();
  return next.find((it) => it.id === id);
}

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(CARD_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(CARD_DIR, { intermediates: true });
}

function captureId() {
  // Date-prefixed so the queue sorts chronologically even after a reinstall.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

// ----------------------------------------------------------------- enqueue

/**
 * Takes the camera's temporary file, shrinks it to something worth uploading, and moves it
 * into durable app storage.
 *
 * 2200 px on the long edge at quality 0.82 is the sweet spot: small enough that a card is
 * ~400 kB over a weak connection, large enough that PP-OCRv5 still reads 6 pt small print.
 * Compressing here rather than server-side is what makes the queue survive — a hundred
 * raw 12 MP frames would fill the phone.
 */
export async function enqueueCapture({ uri, notes = '', tags = [] }) {
  await ensureDir();
  const s = await getSettings();
  const id = captureId();

  const shrunk = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 2200 } }],
    { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG },
  );

  const dest = `${CARD_DIR}${id}.jpg`;
  await FileSystem.moveAsync({ from: shrunk.uri, to: dest });

  // Drop the camera's original immediately; it is a full-resolution duplicate.
  FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});

  const entry = {
    id,
    uri: dest,
    eventId: s.eventId,
    eventName: s.eventName,
    capturedBy: s.staffName,
    deviceLabel: s.deviceLabel,
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
  };

  const items = await readQueue();
  await writeQueue([entry, ...items]);
  await emit();

  // Fire and forget — the caller returns to the camera straight away.
  flush().catch(() => {});
  return entry;
}

/** Lets the review screen attach tags and a note to an item, uploaded or not. */
export async function annotate(id, { notes, tags }) {
  const item = (await readQueue()).find((it) => it.id === id);
  if (!item) return null;

  const patch = {};
  if (notes !== undefined) patch.notes = notes;
  if (tags !== undefined) patch.tags = tags;

  // Already on the server? Push the annotation straight through.
  if (item.status === 'done' && item.leadId) {
    try {
      await api.patchLead(item.leadId, {
        notes: patch.notes ?? item.notes,
        interest_tags: patch.tags ?? item.tags,
        // Keep the server's review flag as-is: the phone has not checked the photo
        // against the fields, so it must not claim the lead was reviewed.
        needs_review: item.needsReview !== false,
      });
    } catch {
      // Queue the change for the next flush instead of losing it.
      patch.annotationPending = true;
    }
  }
  return update(id, patch);
}

// ----------------------------------------------------------------- flush

function dueForRetry(item) {
  if (item.status === 'done') return false;
  if (item.status === 'uploading') return false;
  const wait = BACKOFF[Math.min(item.attempts, BACKOFF.length - 1)] * 1000;
  if (!item.lastAttemptAt) return true;
  return Date.now() - new Date(item.lastAttemptAt).getTime() >= wait;
}

export async function flush({ force = false } = {}) {
  if (flushing) return { skipped: true };
  flushing = true;

  try {
    const net = await Network.getNetworkStateAsync().catch(() => ({ isConnected: true }));
    if (!net.isConnected && !force) return { offline: true };

    let items = await readQueue();
    const pending = items.filter((it) => (force ? it.status !== 'done' : dueForRetry(it)));
    if (!pending.length) return { nothing: true };

    // Ask the server what it already holds, so a connection that dropped *after* the
    // upload succeeded does not cause a pointless re-send of the photo.
    try {
      const ids = pending.map((it) => it.id);
      const { known } = await api.reconcile(ids);
      if (known?.length) {
        for (const id of known) {
          const it = pending.find((p) => p.id === id);
          if (it) {
            await update(id, { status: 'done', lastError: null });
            await discardFile(it.uri);
          }
        }
      }
    } catch {
      // Reconciliation is an optimisation, not a requirement.
    }

    items = await readQueue();
    let uploaded = 0;
    let failed = 0;

    for (const item of items.filter((it) => it.status !== 'done')) {
      await update(item.id, { status: 'uploading', lastAttemptAt: new Date().toISOString() });
      try {
        const res = await api.uploadCard({
          uri: item.uri,
          eventId: item.eventId,
          captureId: item.id,
          capturedBy: item.capturedBy,
          deviceLabel: item.deviceLabel,
          capturedAt: item.capturedAt,
          notes: item.notes,
          tags: item.tags,
        });

        await update(item.id, {
          status: 'done',
          leadId: res.lead?.id || null,
          fields: res.lead
            ? {
                full_name: res.lead.full_name,
                company: res.lead.company,
                designation: res.lead.designation,
                phone_primary: res.lead.phone_primary,
                email: res.lead.email,
                city: res.lead.city,
              }
            : null,
          needsReview: res.lead?.needs_review ?? null,
          duplicateOf: res.possible_duplicate?.full_name || null,
          lastError: null,
          attempts: item.attempts + 1,
        });
        await discardFile(item.uri);
        uploaded++;
      } catch (err) {
        failed++;
        await update(item.id, {
          status: 'pending',
          attempts: item.attempts + 1,
          lastError: err?.code || err?.message || 'upload_failed',
        });
        // A dead network will fail every remaining item the same way; stop early.
        if (err?.code === 'offline') break;
      }
    }

    return { uploaded, failed };
  } finally {
    flushing = false;
    await emit();
  }
}

async function discardFile(uri) {
  if (!uri) return;
  // The server has the photo now; keeping a second copy only fills the phone.
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

// ----------------------------------------------------------------- queries

export async function listQueue() {
  return readQueue();
}

export async function counts() {
  const items = await readQueue();
  return {
    total: items.length,
    pending: items.filter((it) => it.status !== 'done').length,
    done: items.filter((it) => it.status === 'done').length,
    needsReview: items.filter((it) => it.needsReview).length,
    today: items.filter((it) => isToday(it.capturedAt)).length,
  };
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  // Compared in IST, which is what "today" means to someone standing at the stall.
  const fmt = (x) => x.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  return fmt(d) === fmt(now);
}

/** Clears uploaded entries older than a day, so the history list stays readable. */
export async function pruneDone({ olderThanHours = 24 } = {}) {
  const cutoff = Date.now() - olderThanHours * 3600_000;
  const items = await readQueue();
  const keep = items.filter(
    (it) => it.status !== 'done' || new Date(it.capturedAt).getTime() > cutoff,
  );
  if (keep.length !== items.length) {
    await writeQueue(keep);
    await emit();
  }
  return items.length - keep.length;
}

/** Last resort for a stuck item the user chooses to abandon. */
export async function removeItem(id) {
  const items = await readQueue();
  const item = items.find((it) => it.id === id);
  if (item) await discardFile(item.uri);
  await writeQueue(items.filter((it) => it.id !== id));
  await emit();
}
