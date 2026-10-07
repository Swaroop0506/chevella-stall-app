'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, humanise, istDateTime, prettyPhone } from '../../../../lib/api';

const FIELDS = [
  ['full_name', 'Name', 'text'],
  ['designation', 'Designation', 'text'],
  ['company', 'Company', 'text'],
  ['phone_primary', 'Phone', 'tel'],
  ['phone_secondary', 'Phone 2', 'tel'],
  ['whatsapp', 'WhatsApp', 'tel'],
  ['email', 'Email', 'email'],
  ['email_secondary', 'Email 2', 'email'],
  ['website', 'Website', 'url'],
  ['city', 'City', 'text'],
  ['state', 'State', 'text'],
  ['pincode', 'Pincode', 'text'],
  ['gstin', 'GSTIN', 'text'],
];

const STATUSES = ['new', 'contacted', 'qualified', 'converted', 'rejected', 'duplicate'];

/** Shows how sure the OCR was about one field, so weak reads draw the eye. */
function Confidence({ value }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  const cls = pct >= 85 ? 'badge-green' : pct >= 65 ? 'badge-amber' : 'badge-red';
  return <span className={`badge ${cls}`} style={{ marginLeft: 6 }} title="OCR confidence for this field">{pct}%</span>;
}

/** Says so when a value was read off the reverse, so it does not appear from nowhere. */
function FromBack({ on }) {
  if (!on) return null;
  return (
    <span className="badge badge-blue" style={{ marginLeft: 6 }} title="Read from the back of the card">
      back
    </span>
  );
}

export default function LeadDetail({ params }) {
  const { id } = use(params);
  const router = useRouter();

  const [lead, setLead] = useState(null);
  const [dupe, setDupe] = useState(null);
  const [form, setForm] = useState({});
  const [tags, setTags] = useState('');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(() => {
    api.get(`/leads/${id}`)
      .then((r) => {
        setLead(r.lead);
        setDupe(r.possible_duplicate);
        const f = {};
        for (const [k] of FIELDS) f[k] = r.lead[k] || '';
        f.address = r.lead.address || '';
        f.notes = r.lead.notes || '';
        f.status = r.lead.status || 'new';
        setForm(f);
        setTags((r.lead.interest_tags || []).join(', '));
      })
      .catch((e) => setError(humanise(e)));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // needs_review is not sent, so the API clears it — saving *is* the review.
      const { lead: updated } = await api.patch(`/leads/${id}`, { ...form, interest_tags: tags });
      setLead(updated);
      setNote('Saved and marked as reviewed.');
    } catch (e) {
      setError(humanise(e));
    } finally {
      setBusy(false);
    }
  }

  async function reocr(overwrite) {
    setBusy(true);
    setNote('Re-reading the card…');
    try {
      await api.post(`/leads/${id}/reocr?overwrite=${overwrite}`);
      load();
      setNote(overwrite ? 'Re-read and overwrote every field.' : 'Re-read; only empty fields were filled.');
    } catch (e) {
      setNote(null);
      setError(humanise(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Delete this lead and its card photo record? This cannot be undone.')) return;
    await api.del(`/leads/${id}`);
    router.push('/leads');
  }

  if (error && !lead) return <div className="banner banner-err">{error}</div>;
  if (!lead) return <p className="hint">Loading…</p>;

  const conf = lead.field_confidence || {};
  const fromBack = lead.back_filled_fields || {};

  return (
    <>
      <header className="row-between">
        <div>
          <p className="hint" style={{ margin: 0 }}><Link href="/leads">← All leads</Link></p>
          <h1>{lead.full_name || 'Unnamed lead'}</h1>
          <p>
            {lead.event_name} · captured by {lead.captured_by || 'unknown'} · {istDateTime(lead.captured_at)}
            {lead.needs_review && <span className="badge badge-amber" style={{ marginLeft: 8 }}>needs review</span>}
          </p>
        </div>
        <div className="row">
          <button type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : lead.needs_review ? 'Save & mark reviewed' : 'Save changes'}
          </button>
          <button type="button" className="btn-ghost btn-danger btn-sm" onClick={remove}>Delete</button>
        </div>
      </header>

      {error && <div className="banner banner-err">{error}</div>}
      {note && <div className="banner banner-ok">{note}</div>}

      {dupe && (
        <div className="banner banner-warn">
          Possible duplicate: <Link href={`/leads/${dupe.id}`}><b>{dupe.full_name || 'another lead'}</b></Link>
          {dupe.company && ` (${dupe.company})`} has the same phone or email and was captured
          by {dupe.captured_by || 'someone'} on {istDateTime(dupe.captured_at)}.
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 400px) 1fr', alignItems: 'start' }}>
        {/* ------------------------------------------------ the photo */}
        <div className="stack">
          <div className="card card-tight">
            <div className="row-between" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Card photo</h3>
              <span className={`badge ${lead.card_back_path ? 'badge-green' : ''}`}>
                {lead.card_back_path ? 'both sides' : 'front only'}
              </span>
            </div>

            {lead.card_image_path ? (
              <>
                <div className="hint" style={{ marginBottom: 4 }}>Front</div>
                <a href={`/api/v1/files/${lead.card_image_path}`} target="_blank" rel="noreferrer">
                  <img
                    src={`/api/v1/files/${lead.card_image_path}`}
                    alt="Front of the scanned visiting card"
                    style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', display: 'block' }}
                  />
                </a>
              </>
            ) : <p className="hint">No photo stored.</p>}

            {lead.card_back_path ? (
              <>
                <div className="hint" style={{ margin: '12px 0 4px' }}>Back</div>
                <a href={`/api/v1/files/${lead.card_back_path}`} target="_blank" rel="noreferrer">
                  <img
                    src={`/api/v1/files/${lead.card_back_path}`}
                    alt="Back of the scanned visiting card"
                    style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', display: 'block' }}
                  />
                </a>
              </>
            ) : (
              <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
                No back captured. On most Indian B2B cards the address and GSTIN are printed
                on the reverse — worth asking staff to shoot both sides.
              </p>
            )}

            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Click to open full size. Always check the photo before trusting a field.
            </p>
          </div>

          <div className="card card-tight">
            <h3>OCR</h3>
            <table style={{ fontSize: '.84rem' }}>
              <tbody>
                <tr><td>Engine</td><td className="mono">{lead.ocr_engine || '—'}</td></tr>
                <tr><td>Front conf.</td><td>{lead.ocr_confidence != null ? `${Math.round(lead.ocr_confidence * 100)}%` : '—'}</td></tr>
                <tr>
                  <td>Back conf.</td>
                  <td>{lead.ocr_back_confidence != null ? `${Math.round(lead.ocr_back_confidence * 100)}%` : '—'}</td>
                </tr>
                <tr><td>Time</td><td>{lead.ocr_ms ? `${lead.ocr_ms} ms` : '—'}</td></tr>
              </tbody>
            </table>

            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn-ghost btn-sm" onClick={() => reocr(false)} disabled={busy}>
                Re-read (fill gaps)
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => reocr(true)} disabled={busy}>
                Re-read (overwrite)
              </button>
            </div>

            <button
              type="button"
              className="btn-ghost btn-sm"
              style={{ marginTop: 10 }}
              onClick={() => setShowRaw((s) => !s)}
            >
              {showRaw ? 'Hide' : 'Show'} raw OCR text
            </button>
            {showRaw && (
              <pre
                className="mono"
                style={{
                  marginTop: 8, background: 'var(--sand)', padding: 10, borderRadius: 8,
                  whiteSpace: 'pre-wrap', fontSize: '.76rem', maxHeight: 280, overflowY: 'auto',
                }}
              >
                {`— FRONT —\n${lead.ocr_raw_text || '(nothing was read)'}`}
                {lead.ocr_back_text ? `\n\n— BACK —\n${lead.ocr_back_text}` : ''}
              </pre>
            )}
          </div>
        </div>

        {/* ------------------------------------------------ the fields */}
        <div className="stack">
          <div className="card">
            <h3>Captured details</h3>
            <div className="grid grid-2" style={{ gap: 12 }}>
              {FIELDS.map(([key, label, type]) => (
                <div className="field" key={key}>
                  <label htmlFor={`f-${key}`}>
                    {label}
                    <Confidence value={conf[key]} />
                    <FromBack on={fromBack[key]} />
                  </label>
                  <input
                    id={`f-${key}`}
                    type={type}
                    value={form[key] || ''}
                    onChange={set(key)}
                    aria-invalid={Boolean(conf[key] != null && conf[key] < 0.6)}
                  />
                  {type === 'tel' && form[key] && (
                    <div className="hint">{prettyPhone(form[key])}</div>
                  )}
                </div>
              ))}
            </div>

            <div className="field">
              <label htmlFor="f-address">Address</label>
              <textarea id="f-address" value={form.address || ''} onChange={set('address')} />
            </div>
          </div>

          <div className="card">
            <h3>Sales context</h3>

            <div className="field">
              <label htmlFor="f-tags">Interest <span className="opt">(comma separated)</span></label>
              <input
                id="f-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Bulk / Distributor, Instant Coconut Water Powder"
              />
            </div>

            <div className="field">
              <label htmlFor="f-notes">Notes from the stall</label>
              <textarea id="f-notes" value={form.notes || ''} onChange={set('notes')} placeholder="Wants a sample pack couriered; buys ~200 kg/month." />
            </div>

            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="f-status">Status</label>
              <select id="f-status" value={form.status || 'new'} onChange={set('status')}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : lead.needs_review ? 'Save & mark reviewed' : 'Save changes'}
              </button>
              {lead.phone_primary && (
                <a
                  className="btn btn-ghost"
                  href={`https://wa.me/${lead.whatsapp?.replace(/\D/g, '') || lead.phone_primary.replace(/\D/g, '')}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  WhatsApp this lead
                </a>
              )}
              {lead.email && <a className="btn btn-ghost" href={`mailto:${lead.email}`}>Email</a>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
