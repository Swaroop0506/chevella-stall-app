'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Camera from './Camera';
import {
  annotate, attachBack, counts, enqueueCapture, flush, getSettings, isConfigured,
  listQueue, prepareImage, pruneDone, removeItem, saveSettings, scanApi, subscribe,
} from '../../lib/scan-queue';
import './scan.css';   // globals.css already comes in via the root layout

const FALLBACK_TAGS = [
  'Instant Coconut Water Powder', 'Tender Coconut Water', 'Bulk / Distributor',
  'Retail / Store', 'HoReCa', 'Export', 'Private Label', 'Just browsing',
];

const ERRORS = {
  bad_device_key: 'Device key rejected — check Setup',
  event_not_found: 'Event missing on the server',
  file_too_large: 'Photo too large',
  TimeoutError: 'Server was slow — will retry',
  TypeError: 'No connection yet',
  upload_failed: 'Will retry',
};

export default function ScanPage() {
  const [view, setView] = useState('loading');     // loading | setup | home | queue | review
  const [settings, setSettings] = useState(null);
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({ today: 0, done: 0, pending: 0 });
  const [online, setOnline] = useState(true);
  const [camera, setCamera] = useState(false);
  const [reviewId, setReviewId] = useState(null);
  // Capture id whose BACK we are about to photograph, or null for a normal front shot.
  const [backFor, setBackFor] = useState(null);
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);
  const pendingAnnotate = useRef(false);

  // ------------------------------------------------------------- bootstrap

  useEffect(() => {
    /**
     * The admin's share link carries the device key in the URL *fragment*. A fragment is
     * never sent to the server, so it stays out of access logs and Referer headers —
     * unlike a query string. It is consumed once and stripped from the address bar.
     *
     * Also wired to hashchange: following the link while already sitting on /scan is a
     * same-document navigation, so nothing remounts and a mount-only read would silently
     * ignore the key.
     */
    function consumeHash() {
      const m = /[#&]k=([^&]+)/.exec(window.location.hash || '');
      if (!m) return false;
      saveSettings({ deviceKey: decodeURIComponent(m[1]) });
      history.replaceState(null, '', window.location.pathname);
      return true;
    }

    consumeHash();

    const s = getSettings();
    setSettings(s);
    setView(isConfigured(s) ? 'home' : 'setup');

    function onHashChange() {
      if (consumeHash()) {
        const next = getSettings();
        setSettings(next);
        setView(isConfigured(next) ? 'home' : 'setup');
      }
    }
    window.addEventListener('hashchange', onHashChange);

    navigator.serviceWorker?.register('/sw.js').catch(() => {});
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const refresh = useCallback(async () => {
    setItems(await listQueue());
    setStats(await counts());
  }, []);

  useEffect(() => {
    if (view === 'loading' || view === 'setup') return;
    refresh();
    return subscribe((next) => {
      setItems(next);
      counts().then(setStats);
    });
  }, [view, refresh]);

  // Three triggers for draining the queue. The 'online' event is the important one: it
  // fires the instant a phone reattaches to wifi, which at an expo happens constantly.
  useEffect(() => {
    const tick = setInterval(() => flush().catch(() => {}), 30_000);
    const onOnline = () => { setOnline(true); flush({ force: true }).catch(() => {}); };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (!document.hidden) {
        flush().catch(() => {});
        pruneDone().catch(() => {});
      }
    };

    setOnline(navigator.onLine !== false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    flush().catch(() => {});

    return () => {
      clearInterval(tick);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Warn before closing the tab with uploads outstanding — the one real difference
  // between this and the installed app.
  useEffect(() => {
    function beforeUnload(e) {
      if (stats.pending > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [stats.pending]);

  // ------------------------------------------------------------- actions

  /**
   * One handler for every way out of the confirm screen.
   *
   * mode 'next'     — queue it and stay on the camera (the fast path for a queue of people)
   * mode 'back'     — queue it, then immediately reopen the camera for the reverse
   * mode 'annotate' — queue it and jump to tags/notes
   */
  const onCaptured = useCallback(async (blob, { mode = 'next' } = {}) => {
    // Capturing the reverse of a card captured a moment ago.
    if (backFor) {
      await attachBack(backFor, blob);
      setBackFor(null);
      setCamera(false);
      setToast('Back saved.');
      setTimeout(() => setToast(null), 2000);
      return null;
    }

    const entry = await enqueueCapture(blob);

    if (mode === 'back') {
      setBackFor(entry.id);
      return entry;                 // camera stays open, now in back mode
    }
    if (mode === 'annotate') {
      setCamera(false);
      setReviewId(entry.id);
      setView('review');
    }
    return entry;
  }, [backFor]);

  /** "Add back" from the Cards list, for a card already captured. */
  const shootBackFor = useCallback((id) => {
    setBackFor(id);
    setCamera(true);
  }, []);

  async function onFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { blob } = await prepareImage(file);

      // The OS camera can also be used for the back, when live capture is unavailable.
      if (backFor) {
        await attachBack(backFor, blob);
        setBackFor(null);
        setToast('Back saved.');
        setTimeout(() => setToast(null), 2000);
        return;
      }

      const entry = await enqueueCapture(blob);
      if (pendingAnnotate.current) {
        setReviewId(entry.id);
        setView('review');
      } else {
        setToast('Card saved.');
        setTimeout(() => setToast(null), 2200);
      }
    } catch {
      setToast('Could not read that image.');
      setTimeout(() => setToast(null), 3000);
    } finally {
      pendingAnnotate.current = false;
    }
  }

  async function syncNow() {
    const res = await flush({ force: true });
    if (res.offline) setToast('Still no connection. Everything is safe on this phone.');
    else if (res.nothing) setToast('All cards are uploaded.');
    else setToast(`Uploaded ${res.uploaded || 0}${res.failed ? `, ${res.failed} waiting` : ''}.`);
    setTimeout(() => setToast(null), 2600);
  }

  // ------------------------------------------------------------- render

  if (view === 'loading') return <main className="sc" />;

  if (view === 'setup') {
    // Keyed on the device key so a key arriving late (via hashchange) remounts Setup and
    // re-runs its auto-connect, rather than leaving a filled-in field doing nothing.
    return (
      <Setup
        key={settings?.deviceKey || 'none'}
        onDone={(s) => { setSettings(s); setView('home'); }}
      />
    );
  }

  return (
    <main className="sc">
      <header className="sc-head">
        <div>
          <b>Chevella Scanner</b>
          <span>{settings?.staffName || 'Not set up'}</span>
        </div>
        <span className="sc-net" data-off={!online}>{online ? 'online' : 'offline'}</span>
      </header>

      <nav className="sc-tabs">
        <button type="button" data-on={view === 'home'} onClick={() => setView('home')}>Scan</button>
        <button type="button" data-on={view === 'queue' || view === 'review'} onClick={() => setView('queue')}>
          Cards
          {stats.pending > 0 && <span className="sc-dot">{stats.pending}</span>}
        </button>
      </nav>

      <div className="sc-body">
        {toast && <div className="banner banner-ok">{toast}</div>}

        {view === 'home' && (
          <>
            <div className="sc-event">
              <div className="k">SCANNING FOR</div>
              <div className="v">{settings?.eventName || '—'}</div>
              <div className="w">as {settings?.staffName}</div>
            </div>

            {!online && (
              <div className="banner banner-warn">
                No connection. Keep scanning — every card is saved in this browser and
                uploads by itself when signal returns. <b>Leave this tab open.</b>
              </div>
            )}

            <div className="sc-stats">
              <div className="sc-stat"><b>{stats.today}</b><span>Today</span></div>
              <div className="sc-stat"><b>{stats.done}</b><span>Uploaded</span></div>
              <div className="sc-stat" data-warn={stats.pending > 0}>
                <b>{stats.pending}</b><span>Waiting</span>
              </div>
            </div>

            <button type="button" className="sc-shoot" onClick={() => setCamera(true)}>
              📷 Scan a visiting card
            </button>

            <button
              type="button"
              className="btn-ghost"
              style={{ width: '100%', justifyContent: 'center', marginBottom: 10 }}
              onClick={() => { pendingAnnotate.current = false; fileRef.current?.click(); }}
            >
              Use my phone camera app instead
            </button>

            <button
              type="button"
              className="btn-ghost"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={syncNow}
            >
              {stats.pending ? `Sync now (${stats.pending} waiting)` : 'Sync now'}
            </button>

            <p className="sc-note">
              Lay the card flat, fill the guide box, let it focus. Saving is instant — the
              upload and the text reading happen in the background.
            </p>
            <p className="sc-note">
              Add this page to your home screen and it opens like an app, full screen.
            </p>
          </>
        )}

        {view === 'queue' && (
          <Queue
            items={items}
            onSync={syncNow}
            onOpen={(id) => { setReviewId(id); setView('review'); }}
            onAddBack={shootBackFor}
          />
        )}

        {view === 'review' && (
          <Review
            id={reviewId}
            items={items}
            tags={settings?.interestTags?.length ? settings.interestTags : FALLBACK_TAGS}
            onAddBack={shootBackFor}
            onDone={() => setView('queue')}
          />
        )}
      </div>

      {camera && (
        <Camera
          side={backFor ? 'back' : 'front'}
          onCaptured={onCaptured}
          onClose={() => { setCamera(false); setBackFor(null); }}
          onCameraFailed={(why) => {
            setCamera(false);
            setToast(
              why === 'NotAllowedError'
                ? 'Camera blocked. Allow it in the address bar, or use your phone camera app.'
                : 'Live camera unavailable here — opening your phone camera instead.',
            );
            setTimeout(() => setToast(null), 4000);
            if (why !== 'NotAllowedError') fileRef.current?.click();
          }}
        />
      )}

      {/* The OS camera fallback. `capture` makes Android and iOS open the camera app
          directly rather than a file browser, and returns a full-resolution photo. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFilePicked}
        style={{ display: 'none' }}
      />
    </main>
  );
}

// ------------------------------------------------------------------ setup

function Setup({ onDone }) {
  const [key, setKey] = useState(() => getSettings().deviceKey || '');
  const [name, setName] = useState(() => getSettings().staffName || '');
  const [label, setLabel] = useState(() => getSettings().deviceLabel || '');
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState(() => getSettings().eventId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const connect = useCallback(async (candidate) => {
    const k = (candidate ?? key).trim();
    if (!k) { setError('Paste the device key, or open the link your admin sent.'); return; }
    setBusy(true); setError(null); setStatus(null);
    try {
      saveSettings({ deviceKey: k });
      const hello = await scanApi.handshake();
      const { events: list } = await scanApi.events();
      saveSettings({ interestTags: hello.interest_tags || [] });
      setEvents(list);
      if (!list.length) {
        setError('Connected, but there are no active or upcoming events yet.');
        return;
      }
      const active = list.find((e) => e.status === 'active') || list[0];
      setEventId((cur) => (list.some((e) => e.id === cur) ? cur : active.id));
      setStatus(`Connected. ${list.length} event${list.length > 1 ? 's' : ''} available.`);
    } catch (err) {
      setError(err?.status === 401
        ? 'That device key was rejected. Check it with your admin.'
        : 'Could not reach the server. Check your connection.');
    } finally {
      setBusy(false);
    }
  }, [key]);

  // A key arriving from the share link should connect without anyone pressing anything.
  useEffect(() => {
    const k = getSettings().deviceKey;
    if (k) connect(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish() {
    if (!name.trim()) { setError('Enter your name so leads are credited to you.'); return; }
    const ev = events.find((e) => e.id === eventId);
    if (!ev) { setError('Pick the event you are working.'); return; }
    onDone(saveSettings({
      staffName: name.trim(),
      deviceLabel: label.trim(),
      eventId: ev.id,
      eventName: ev.name,
    }));
  }

  return (
    <main className="sc">
      <header className="sc-head">
        <div><b>Chevella Scanner</b><span>Set up this phone</span></div>
      </header>

      <div className="sc-body">
        {error && <div className="banner banner-err">{error}</div>}
        {status && <div className="banner banner-ok">{status}</div>}

        <div className="card">
          <h3>1 · Connect</h3>
          <div className="sc-field">
            <label htmlFor="sk">Device key</label>
            <input
              id="sk"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="paste the key from your admin"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="hint">
              If you opened the link your admin sent, this is already filled in.
            </div>
          </div>
          <button type="button" onClick={() => connect()} disabled={busy}
                  style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>

        <div className="card">
          <h3>2 · Who you are</h3>
          <div className="sc-field">
            <label htmlFor="sn">Your name</label>
            <input id="sn" value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="Swaroop" autoCapitalize="words" />
            <div className="hint">Shown against every card you scan.</div>
          </div>
          <div className="sc-field">
            <label htmlFor="sl">Phone label <span className="opt">(optional)</span></label>
            <input id="sl" value={label} onChange={(e) => setLabel(e.target.value)}
                   placeholder="Stall phone 2" />
          </div>
        </div>

        <div className="card">
          <h3>3 · Event</h3>
          {events.length === 0 && <p className="hint">Connect first to load the list.</p>}
          {events.map((e) => (
            <button
              key={e.id}
              type="button"
              className="sc-pick"
              data-on={e.id === eventId}
              onClick={() => setEventId(e.id)}
            >
              <b>{e.name}</b>
              <small>
                {[e.venue, e.stall_no && `Stall ${e.stall_no}`, e.city].filter(Boolean).join(' · ') || 'No venue set'}
              </small>
              {e.status === 'active' && <span className="live">● ACTIVE NOW</span>}
            </button>
          ))}
        </div>

        <button type="button" onClick={finish} disabled={!events.length}
                style={{ width: '100%', justifyContent: 'center', padding: 16 }}>
          Start scanning
        </button>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ queue

function Queue({ items, onSync, onOpen, onAddBack }) {
  const pending = items.filter((i) => i.status !== 'done').length;

  return (
    <>
      {pending > 0 ? (
        <div className="banner banner-warn">
          {pending} card{pending > 1 ? 's' : ''} still on this phone. They upload by
          themselves — <b>keep this tab open</b> until this reaches zero.
        </div>
      ) : (
        <div className="banner banner-ok">Everything is uploaded. Safe to close the tab.</div>
      )}

      <button type="button" className="btn-ghost" onClick={onSync}
              style={{ width: '100%', justifyContent: 'center', marginBottom: 14 }}>
        Sync now
      </button>

      {items.length === 0 && <p className="hint" style={{ textAlign: 'center', marginTop: 32 }}>
        No cards captured yet.
      </p>}

      {items.map((it) => {
        const when = new Date(it.capturedAt).toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
        });
        return (
          <div key={it.id} className="sc-row" onClick={() => onOpen(it.id)} role="button" tabIndex={0}
               onKeyDown={(e) => e.key === 'Enter' && onOpen(it.id)}>
            <div className="pic">{it.status === 'done' ? '✓' : '⏳'}</div>
            <div className="mid">
              <b>{it.fields?.full_name || it.fields?.company || `Card at ${when}`}</b>
              <small>
                {it.fields?.company && it.fields?.full_name ? it.fields.company : when}
                {it.status !== 'done' && it.lastError
                  ? ` · ${ERRORS[it.lastError] || it.lastError}`
                  : ''}
                {it.needsReview ? ' · needs review' : ''}
              </small>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
              <span className="st" data-s={it.status}>
                {it.status === 'done' ? 'uploaded' : it.status === 'uploading' ? 'uploading' : 'waiting'}
              </span>
              {it.hasBack ? (
                <span className="st" data-s="done" title="Both sides captured">front + back</span>
              ) : (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); onAddBack(it.id); }}
                >
                  + back
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------ review

function Review({ id, items, tags, onDone, onAddBack }) {
  const item = items.find((i) => i.id === id);
  const [picked, setPicked] = useState(item?.tags || []);
  const [notes, setNotes] = useState(item?.notes || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPicked(item?.tags || []);
    setNotes(item?.notes || '');
  }, [id]);                                  // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return <p className="hint">That capture is no longer in the queue.</p>;

  async function save() {
    setBusy(true);
    try {
      await annotate(id, { tags: picked, notes: notes.trim() });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  async function drop() {
    if (!confirm('Drop this card? The photo is deleted and never reaches the server.')) return;
    await removeItem(id);
    onDone();
  }

  const f = item.fields;

  return (
    <>
      {item.status !== 'done' && (
        <div className="banner banner-warn">
          Saved here, not uploaded yet. The text is read on the server, so the details
          below fill in once it uploads.
        </div>
      )}

      {item.duplicateOf && (
        <div className="banner banner-warn">
          Looks like a repeat: {item.duplicateOf} was already captured at this event.
          Saved anyway — the admin can merge them.
        </div>
      )}

      {f && (
        <div className="card">
          <h3>What the server read</h3>
          {[['Name', f.full_name], ['Company', f.company], ['Role', f.designation],
            ['Phone', f.phone_primary], ['Email', f.email], ['City', f.city]].map(([k, v]) => (
            <div key={k} className="row" style={{ gap: 10, padding: '3px 0' }}>
              <span style={{ width: 76, fontSize: '.72rem', fontWeight: 700, color: 'var(--muted)',
                             textTransform: 'uppercase', letterSpacing: '.05em' }}>{k}</span>
              <span style={{ flex: 1, color: v ? 'var(--ink)' : 'var(--muted)' }}>{v || '—'}</span>
            </div>
          ))}
          <p className="hint" style={{ marginTop: 10 }}>
            {item.needsReview
              ? 'Flagged for a human to check in the admin console.'
              : 'Read cleanly. No review needed.'}
          </p>
        </div>
      )}

      <div className="card">
        <h3>What are they interested in?</h3>
        <div className="sc-chips">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              className="sc-chip"
              data-on={picked.includes(t)}
              onClick={() => setPicked((p) => p.includes(t) ? p.filter((x) => x !== t) : [...p, t])}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="sc-field">
          <label htmlFor="rn">Note</label>
          <textarea
            id="rn"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Wants a sample pack couriered. Buys ~200 kg a month."
          />
        </div>
      </div>

      <button type="button" onClick={save} disabled={busy}
              style={{ width: '100%', justifyContent: 'center', padding: 15 }}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {!item.hasBack && (
        <button type="button" className="btn-ghost" onClick={() => onAddBack(id)}
                style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
          📷 Photograph the back of this card
        </button>
      )}
      <button type="button" className="btn-ghost" onClick={onDone}
              style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
        Back to list
      </button>
      {item.status !== 'done' && (
        <button type="button" className="btn-ghost btn-danger" onClick={drop}
                style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>
          Drop this card
        </button>
      )}
    </>
  );
}
