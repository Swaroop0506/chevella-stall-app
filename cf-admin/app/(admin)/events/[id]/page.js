'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, humanise, istDate, prettyPhone } from '../../../../lib/api';

const EMPTY_CONTACT = {
  name: '', designation: '', phone: '', whatsapp: '', email: '', wa_prefill: '',
};

/** Add/edit form for one person on the stall. */
function ContactDialog({ eventId, eventName, contact, onSaved, trigger }) {
  const ref = useRef(null);
  const editing = Boolean(contact);
  const [form, setForm] = useState(EMPTY_CONTACT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const open = () => {
    setError(null);
    setForm(contact ? {
      name: contact.name || '',
      designation: contact.designation || '',
      phone: contact.phone_e164 || '',
      whatsapp: contact.whatsapp_e164 === contact.phone_e164 ? '' : (contact.whatsapp_e164 || ''),
      email: contact.email || '',
      wa_prefill: contact.wa_prefill || '',
    } : EMPTY_CONTACT);
    ref.current?.showModal();
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form };
      // Blank WhatsApp means "same as phone" — the API applies that default.
      if (!payload.whatsapp) delete payload.whatsapp;
      if (editing) await api.patch(`/contacts/${contact.id}`, payload);
      else await api.post(`/events/${eventId}/contacts`, payload);
      ref.current?.close();
      onSaved?.();
    } catch (err) {
      setError(humanise(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {trigger ? trigger(open) : <button type="button" onClick={open}>+ Add contact</button>}

      <dialog ref={ref}>
        <form onSubmit={save}>
          <div className="modal-head">{editing ? `Edit ${contact.name}` : 'Add a contact'}</div>
          <div className="modal-body">
            {error && <div className="banner banner-err">{error}</div>}

            <div className="field">
              <label htmlFor="c-name">Name</label>
              <input id="c-name" required autoFocus placeholder="Sai Swaroop" value={form.name} onChange={set('name')} />
            </div>

            <div className="field">
              <label htmlFor="c-role">Designation <span className="opt">(optional — printed under the name)</span></label>
              <input id="c-role" placeholder="Sales Head" value={form.designation} onChange={set('designation')} />
            </div>

            <div className="grid grid-2" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="c-phone">Phone</label>
                <input
                  id="c-phone"
                  required
                  inputMode="tel"
                  placeholder="9701221934"
                  value={form.phone}
                  onChange={set('phone')}
                />
                <div className="hint">10 digits is enough — +91 is added automatically.</div>
              </div>
              <div className="field">
                <label htmlFor="c-wa">WhatsApp <span className="opt">(if different)</span></label>
                <input
                  id="c-wa"
                  inputMode="tel"
                  placeholder="same as phone"
                  value={form.whatsapp}
                  onChange={set('whatsapp')}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="c-email">Email <span className="opt">(optional)</span></label>
              <input id="c-email" type="email" placeholder="info@fristerfoods.com" value={form.email} onChange={set('email')} />
            </div>

            <div className="field">
              <label htmlFor="c-wa-msg">WhatsApp opening message <span className="opt">(optional)</span></label>
              <textarea
                id="c-wa-msg"
                placeholder={`Hi ${form.name || 'there'}, I met you at ${eventName} and I'd like to know more about Chevella Farms coconut water.`}
                value={form.wa_prefill}
                onChange={set('wa_prefill')}
              />
              <div className="hint">
                Pre-typed in the visitor's WhatsApp when they tap through, so they only have
                to press send. Left blank, a sensible default is used.
              </div>
            </div>
          </div>

          <div className="modal-foot">
            <button type="button" className="btn-ghost" onClick={() => ref.current?.close()}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add contact & make QR'}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function QrTile({ contact, eventId, eventName, onChanged }) {
  const [kind, setKind] = useState('page');
  const [busy, setBusy] = useState(false);
  // Cache-busting token so the <img> refetches after an edit changes the payload.
  const [v, setV] = useState(() => Date.now());

  useEffect(() => { setV(Date.now()); }, [contact.updated_at, contact.code]);

  const src = kind === 'vcard'
    ? `/api/v1/contacts/${contact.id}/qr.png?type=vcard&size=512&v=${v}`
    : `/api/v1/contacts/${contact.id}/qr.png?size=512&v=${v}`;

  async function copy() {
    await navigator.clipboard?.writeText(contact.public_url);
  }

  async function remove() {
    if (!confirm(`Hide ${contact.name}'s QR?\n\nPrinted codes keep resolving but will show "no longer available". Nothing is deleted.`)) return;
    setBusy(true);
    try { await api.del(`/contacts/${contact.id}`); onChanged?.(); } finally { setBusy(false); }
  }

  async function restore() {
    setBusy(true);
    try { await api.patch(`/contacts/${contact.id}`, { is_active: true }); onChanged?.(); } finally { setBusy(false); }
  }

  return (
    <div className="qr-tile" style={contact.is_active ? undefined : { opacity: .55 }}>
      <img src={src} alt={`QR code for ${contact.name}`} />

      <div className="name">{contact.name}</div>
      {contact.designation && <div className="role">{contact.designation}</div>}
      <div className="phone">{prettyPhone(contact.phone_e164)}</div>

      {!contact.whatsapp_reachable && (
        <div className="badge badge-amber" style={{ marginTop: 6 }}>
          not a mobile — WhatsApp won&apos;t work
        </div>
      )}
      {!contact.is_active && <div className="badge" style={{ marginTop: 6 }}>hidden</div>}

      <div className="row" style={{ justifyContent: 'center', gap: 12, marginTop: 10, fontSize: '.78rem', color: 'var(--muted)' }}>
        <span title="QR scans">◉ {contact.scan_count ?? 0}</span>
        <span title="Contacts saved">↓ {contact.save_count ?? 0}</span>
        <span title="WhatsApp taps">◆ {contact.whatsapp_count ?? 0}</span>
      </div>

      <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          style={{ fontSize: '.78rem', padding: '4px 8px', width: 'auto' }}
          aria-label="QR type"
        >
          <option value="page">Page QR (save + WhatsApp)</option>
          <option value="vcard" disabled={!contact.vcard_qr_available}>
            Direct vCard QR (works offline)
          </option>
        </select>
      </div>

      {kind === 'page'
        ? <div className="qr-url">{contact.public_url}</div>
        : <div className="hint" style={{ marginTop: 7 }}>Saves the contact with no internet needed — but no WhatsApp button.</div>}

      <div className="acts">
        <a className="btn btn-ghost btn-sm" href={src.replace('size=512', 'size=2048')} download={`qr-${contact.code}.png`}>PNG</a>
        <a className="btn btn-ghost btn-sm" href={`/api/v1/contacts/${contact.id}/qr.svg${kind === 'vcard' ? '?type=vcard' : ''}`} target="_blank" rel="noreferrer">SVG</a>
        <a className="btn btn-ghost btn-sm" href={contact.public_url} target="_blank" rel="noreferrer">Preview</a>
        <button type="button" className="btn-ghost btn-sm" onClick={copy}>Copy link</button>
        <ContactDialog
          eventId={eventId}
          eventName={eventName}
          contact={contact}
          onSaved={onChanged}
          trigger={(open) => <button type="button" className="btn-ghost btn-sm" onClick={open}>Edit</button>}
        />
        {contact.is_active
          ? <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={remove}>Hide</button>
          : <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={restore}>Restore</button>}
      </div>
    </div>
  );
}

export default function EventDetail({ params }) {
  const { id } = use(params);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(
    () => api.get(`/events/${id}`).then(setData).catch((e) => setError(humanise(e))),
    [id],
  );

  useEffect(() => { load(); }, [load]);

  async function setStatus(status) {
    await api.patch(`/events/${id}`, { status });
    load();
  }

  async function download(mode) {
    setNote('Building the print pack…');
    try {
      const name = await api.download(`/events/${id}/print.pdf?mode=${mode}`, 'qr-pack.pdf');
      setNote(`Downloaded ${name}`);
    } catch (e) {
      setNote(null);
      setError(humanise(e));
    }
  }

  if (error) return <div className="banner banner-err">{error}</div>;
  if (!data) return <p className="hint">Loading…</p>;

  const { event, contacts, stats, website_qr } = data;
  const active = contacts.filter((c) => c.is_active);

  return (
    <>
      <header className="row-between">
        <div>
          <p className="hint" style={{ margin: 0 }}><Link href="/events">← All events</Link></p>
          <h1>{event.name}</h1>
          <p>
            {[event.venue, event.stall_no && `Stall ${event.stall_no}`, event.city].filter(Boolean).join(' · ') || 'No venue set'}
            {event.start_date && ` · ${istDate(event.start_date)} → ${istDate(event.end_date)}`}
          </p>
        </div>
        <div className="row">
          <select value={event.status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Event status">
            <option value="upcoming">Upcoming</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="archived">Archived</option>
          </select>
          <ContactDialog eventId={id} eventName={event.name} onSaved={load} />
        </div>
      </header>

      {note && <div className="banner banner-ok">{note}</div>}

      {event.status !== 'active' && (
        <div className="banner banner-warn">
          This event is <b>{event.status}</b>, so it {event.status === 'upcoming' ? 'appears in' : 'is hidden from'} the
          scanner app&apos;s event list. Set it to <b>Active</b> on the morning of the event.
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <div className="stat"><div className="label">Contact QRs</div><div className="value">{active.length}</div></div>
        <div className="stat"><div className="label">Leads captured</div><div className="value">{stats.leads}</div><div className="sub">{stats.leads_24h} in last 24 h</div></div>
        <div className="stat" data-tone={stats.needs_review ? 'warn' : undefined}>
          <div className="label">Needs review</div>
          <div className="value">{stats.needs_review}</div>
          {stats.needs_review > 0 && <div className="sub"><Link href={`/leads?event_id=${id}&needs_review=true`}>Review now →</Link></div>}
        </div>
        <div className="stat"><div className="label">Staff capturing</div><div className="value">{stats.staff}</div></div>
      </div>

      {/* ---------------------------------------------------------- print pack */}
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="row-between">
          <div style={{ maxWidth: 560 }}>
            <h3>Print pack for the stall</h3>
            <p className="hint" style={{ margin: 0 }}>
              A4 PDFs, ready for any printer. The pack always opens with the website QR, then one
              page per contact reading <b>&ldquo;Scan here to save our contact&rdquo;</b>.
            </p>
          </div>
          <div className="row">
            <button type="button" onClick={() => download('poster')} disabled={!active.length}>
              Posters (1 per page)
            </button>
            <button type="button" className="btn-ghost" onClick={() => download('tent')} disabled={!active.length}>
              Table tents (4 per page)
            </button>
          </div>
        </div>
        {!active.length && (
          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            Add at least one contact to enable the print pack.
          </p>
        )}
      </div>

      {/* ---------------------------------------------------------- website QR */}
      <div className="card" style={{ marginBottom: 22 }}>
        <h3>Website QR</h3>
        <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
          <img
            src={`${website_qr.png}?size=512`}
            alt="QR code to the Chevella Farms website"
            style={{ width: 150, height: 150, border: '1px solid var(--line)', borderRadius: 8 }}
          />
          <div>
            <p style={{ marginBottom: 6 }}>Put this one on the backdrop. It opens:</p>
            <p className="mono" style={{ marginBottom: 12 }}>{website_qr.target}</p>
            <div className="row">
              <a className="btn btn-ghost btn-sm" href={`${website_qr.png}?size=2048`} download="chevella-website-qr.png">Download PNG</a>
              <a className="btn btn-ghost btn-sm" href={website_qr.svg} target="_blank" rel="noreferrer">SVG (print)</a>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------- contacts */}
      <h2 style={{ marginTop: 28 }}>Contact QR codes</h2>
      <p className="hint">
        Each person gets their own code. A scan opens a Chevella-branded page with
        <b> Save contact</b> and <b>WhatsApp us</b> buttons — the visitor&apos;s phone saves you
        in two taps.
      </p>

      {contacts.length === 0 ? (
        <div className="card empty">
          <h3>No contacts yet</h3>
          <p>Add everyone who will be standing at the stall. Each one gets a unique QR code.</p>
          <ContactDialog eventId={id} eventName={event.name} onSaved={load} />
        </div>
      ) : (
        <div className="grid grid-3" style={{ marginTop: 14 }}>
          {contacts.map((c) => (
            <QrTile key={c.id} contact={c} eventId={id} eventName={event.name} onChanged={load} />
          ))}
        </div>
      )}
    </>
  );
}
