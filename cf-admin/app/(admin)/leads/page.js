'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, humanise, istDateTime, prettyPhone, relative } from '../../../lib/api';

const STATUSES = ['new', 'contacted', 'qualified', 'converted', 'rejected', 'duplicate'];
const STATUS_BADGE = {
  new: 'badge-blue', contacted: 'badge', qualified: 'badge-green',
  converted: 'badge-green', rejected: 'badge-red', duplicate: 'badge-amber',
};

function LeadsInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [events, setEvents] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [page, setPage] = useState(0);

  const filters = {
    event_id: params.get('event_id') || '',
    status: params.get('status') || '',
    needs_review: params.get('needs_review') || '',
    q: params.get('q') || '',
    captured_by: params.get('captured_by') || '',
  };
  const [q, setQ] = useState(filters.q);

  const limit = 50;

  const query = useCallback((extra = {}) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) sp.set(k, v);
    return sp.toString();
  }, [params]);                                 // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    const sp = new URLSearchParams(query());
    sp.set('limit', String(limit));
    sp.set('offset', String(page * limit));
    api.get(`/leads?${sp}`).then(setData).catch((e) => setError(humanise(e)));
  }, [query, page]);

  useEffect(() => { api.get('/events').then((r) => setEvents(r.events)).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); setSelected(new Set()); }, [params]);

  function setFilter(key, value) {
    router.push(`/leads?${query({ [key]: value })}`);
  }

  function submitSearch(e) {
    e.preventDefault();
    setFilter('q', q);
  }

  async function exportXlsx(withImages) {
    setNote('Building the Excel file — embedding card photos takes a few seconds…');
    try {
      const sp = new URLSearchParams(query());
      sp.set('images', withImages ? 'true' : 'false');
      const name = await api.download(`/leads/export.xlsx?${sp}`, 'chevella-leads.xlsx');
      setNote(`Downloaded ${name}`);
    } catch (e) {
      setNote(null);
      setError(humanise(e));
    }
  }

  async function bulkStatus(status) {
    if (!selected.size) return;
    await api.post('/leads/bulk-status', { ids: [...selected], status });
    setSelected(new Set());
    load();
  }

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const leads = data?.leads || [];
  const total = data?.total ?? 0;
  const pages = Math.ceil(total / limit);
  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <>
      <header className="row-between">
        <div>
          <h1>Leads</h1>
          <p>
            {total} visiting card{total === 1 ? '' : 's'} captured
            {activeFilters > 0 && ' (filtered)'} · tap a row to check the photo against the data.
          </p>
        </div>
        <div className="row">
          <button type="button" onClick={() => exportXlsx(true)} disabled={!total}>
            Export to Excel
          </button>
          <button type="button" className="btn-ghost" onClick={() => exportXlsx(false)} disabled={!total}>
            Excel without photos
          </button>
        </div>
      </header>

      {error && <div className="banner banner-err">{error}</div>}
      {note && <div className="banner banner-ok">{note}</div>}

      <div className="card card-tight" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <form onSubmit={submitSearch} style={{ flex: '1 1 240px', display: 'flex', gap: 6 }}>
            <input
              placeholder="Search name, company, phone, email, OCR text…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search leads"
            />
            <button type="submit" className="btn-ghost">Search</button>
          </form>

          <select value={filters.event_id} onChange={(e) => setFilter('event_id', e.target.value)} style={{ width: 'auto' }} aria-label="Filter by event">
            <option value="">All events</option>
            {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>

          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={{ width: 'auto' }} aria-label="Filter by status">
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select value={filters.needs_review} onChange={(e) => setFilter('needs_review', e.target.value)} style={{ width: 'auto' }} aria-label="Filter by review state">
            <option value="">Reviewed or not</option>
            <option value="true">Needs review</option>
            <option value="false">Already reviewed</option>
          </select>

          {activeFilters > 0 && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => router.push('/leads')}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="card card-tight row" style={{ marginBottom: 14, background: 'var(--leaf-soft)' }}>
          <b>{selected.size} selected</b>
          <span className="spacer" />
          {STATUSES.map((s) => (
            <button key={s} type="button" className="btn-ghost btn-sm" onClick={() => bulkStatus(s)}>
              Mark {s}
            </button>
          ))}
        </div>
      )}

      {data === null && <p className="hint">Loading…</p>}

      {data && leads.length === 0 && (
        <div className="card empty">
          <h3>{activeFilters ? 'No leads match these filters' : 'No leads captured yet'}</h3>
          <p>
            {activeFilters
              ? 'Try clearing the filters.'
              : 'Install the scanner app on the stall phones and start scanning visiting cards.'}
          </p>
          {!activeFilters && <Link href="/mobile-setup" className="btn">Set up the scanner app →</Link>}
        </div>
      )}

      {leads.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={selected.size === leads.length && leads.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set())}
                      style={{ width: 'auto' }}
                    />
                  </th>
                  <th>Card</th>
                  <th>Name / Company</th>
                  <th>Contact</th>
                  <th>City</th>
                  <th>Event</th>
                  <th>By</th>
                  <th>Captured</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${l.full_name || 'lead'}`}
                        checked={selected.has(l.id)}
                        onChange={() => toggle(l.id)}
                        style={{ width: 'auto' }}
                      />
                    </td>
                    <td>
                      <Link href={`/leads/${l.id}`}>
                        {l.card_thumb_path
                          ? <img className="thumb" src={`/api/v1/files/${l.card_thumb_path}`} alt="" loading="lazy" />
                          : <span className="thumb" />}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/leads/${l.id}`}>
                        <b>{l.full_name || <span style={{ color: 'var(--muted)' }}>no name read</span>}</b>
                      </Link>
                      {l.needs_review && <span className="badge badge-amber" style={{ marginLeft: 6 }}>review</span>}
                      <div className="hint">{[l.designation, l.company].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="hint">
                      {l.phone_primary && <div className="mono">{prettyPhone(l.phone_primary)}</div>}
                      {l.email && <div>{l.email}</div>}
                      {!l.phone_primary && !l.email && <span className="badge badge-red">no contact</span>}
                    </td>
                    <td className="hint">{l.city || '—'}</td>
                    <td className="hint">{l.event_name}</td>
                    <td className="hint">{l.captured_by || '—'}</td>
                    <td className="hint" title={istDateTime(l.captured_at)}>{relative(l.captured_at)}</td>
                    <td><span className={`badge ${STATUS_BADGE[l.status] || ''}`}>{l.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button type="button" className="btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ← Previous
              </button>
              <span className="hint">Page {page + 1} of {pages}</span>
              <button type="button" className="btn-ghost btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function LeadsPage() {
  // useSearchParams needs a Suspense boundary during prerender.
  return (
    <Suspense fallback={<p className="hint">Loading…</p>}>
      <LeadsInner />
    </Suspense>
  );
}
