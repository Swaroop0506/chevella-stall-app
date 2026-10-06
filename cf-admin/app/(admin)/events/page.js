'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, humanise, istDate } from '../../../lib/api';

const STATUS_BADGE = {
  active: 'badge-green',
  upcoming: 'badge-blue',
  completed: 'badge',
  archived: 'badge',
};

function NewEventDialog({ onCreated }) {
  const ref = useRef(null);
  const router = useRouter();
  const [form, setForm] = useState({
    name: '', venue: '', stall_no: '', city: '',
    start_date: '', end_date: '', status: 'upcoming',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { event } = await api.post('/events', form);
      ref.current?.close();
      onCreated?.(event);
      // Straight to the detail page — the next thing you want is to add contacts.
      router.push(`/events/${event.id}`);
    } catch (err) {
      setError(humanise(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => ref.current?.showModal()}>+ New event</button>

      <dialog ref={ref}>
        <form onSubmit={create}>
          <div className="modal-head">New event</div>
          <div className="modal-body">
            {error && <div className="banner banner-err">{error}</div>}

            <div className="field">
              <label htmlFor="ev-name">Event name</label>
              <input
                id="ev-name"
                required
                autoFocus
                placeholder="AAHAR Hyderabad 2026"
                value={form.name}
                onChange={set('name')}
              />
            </div>

            <div className="grid grid-2" style={{ gap: 12 }}>
              <div className="field">
                <label htmlFor="ev-venue">Venue <span className="opt">(optional)</span></label>
                <input id="ev-venue" placeholder="HITEX Exhibition Centre" value={form.venue} onChange={set('venue')} />
              </div>
              <div className="field">
                <label htmlFor="ev-stall">Stall no. <span className="opt">(optional)</span></label>
                <input id="ev-stall" placeholder="Hall 2, B-14" value={form.stall_no} onChange={set('stall_no')} />
              </div>
              <div className="field">
                <label htmlFor="ev-city">City <span className="opt">(optional)</span></label>
                <input id="ev-city" placeholder="Hyderabad" value={form.city} onChange={set('city')} />
              </div>
              <div className="field">
                <label htmlFor="ev-status">Status</label>
                <select id="ev-status" value={form.status} onChange={set('status')}>
                  <option value="upcoming">Upcoming</option>
                  <option value="active">Active — staff can capture leads</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="ev-start">Starts</label>
                <input id="ev-start" type="date" value={form.start_date} onChange={set('start_date')} />
              </div>
              <div className="field">
                <label htmlFor="ev-end">Ends</label>
                <input id="ev-end" type="date" value={form.end_date} onChange={set('end_date')} />
              </div>
            </div>

            <p className="hint">
              Only <b>active</b> and <b>upcoming</b> events appear in the scanner app, with active
              ones listed first.
            </p>
          </div>

          <div className="modal-foot">
            <button type="button" className="btn-ghost" onClick={() => ref.current?.close()}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create event'}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export default function EventsPage() {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const load = () => api.get('/events').then((r) => setEvents(r.events)).catch((e) => setError(humanise(e)));

  useEffect(() => { load(); }, []);

  return (
    <>
      <header className="row-between">
        <div>
          <h1>Events &amp; QR codes</h1>
          <p>One event per stall. Add your team's contacts inside an event to generate their QR codes.</p>
        </div>
        <NewEventDialog onCreated={load} />
      </header>

      {error && <div className="banner banner-err">{error}</div>}

      {events === null && <p className="hint">Loading…</p>}

      {events?.length === 0 && (
        <div className="card empty">
          <h3>No events yet</h3>
          <p>
            Create one for the stall you are setting up. You will then add each person who
            will be on the stall, and every one of them gets their own QR code.
          </p>
        </div>
      )}

      {events?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Dates</th>
                <th>Status</th>
                <th className="num">Contact QRs</th>
                <th className="num">Scans</th>
                <th className="num">Leads</th>
                <th className="num">To review</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link href={`/events/${e.id}`}><b>{e.name}</b></Link>
                    {(e.venue || e.stall_no) && (
                      <div className="hint">
                        {[e.venue, e.stall_no && `Stall ${e.stall_no}`, e.city].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="hint">
                    {e.start_date ? `${istDate(e.start_date)} → ${istDate(e.end_date)}` : '—'}
                  </td>
                  <td><span className={`badge ${STATUS_BADGE[e.status] || ''}`}>{e.status}</span></td>
                  <td className="num">{e.contact_count}</td>
                  <td className="num">{e.scan_count}</td>
                  <td className="num">{e.lead_count}</td>
                  <td className="num">
                    {e.review_count > 0
                      ? <Link href={`/leads?event_id=${e.id}&needs_review=true`}><b>{e.review_count}</b></Link>
                      : '—'}
                  </td>
                  <td>
                    <Link href={`/events/${e.id}`} className="btn btn-ghost btn-sm">Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
