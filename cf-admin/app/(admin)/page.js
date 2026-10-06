'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, humanise } from '../../lib/api';

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat" data-tone={tone}>
      <div className="label">{label}</div>
      <div className="value">{value ?? '—'}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

const DAY_MS = 86400000;
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Fills in the days the API returned nothing for.
 *
 * The query only returns days that had captures, so a brand-new install would otherwise
 * draw a single bar stretched across the whole card, which reads as "every day was busy"
 * rather than "one day had two". Always rendering a continuous 30-day axis keeps the
 * shape honest.
 */
function densify(days, span = 30) {
  const byDay = new Map((days || []).map((d) => [dayKey(d.day), d.leads]));
  const end = Date.now();
  const out = [];
  for (let i = span - 1; i >= 0; i--) {
    const date = new Date(end - i * DAY_MS);
    const key = dayKey(date);
    out.push({ day: key, leads: byDay.get(key) || 0 });
  }
  return out;
}

/** 30-day capture trend. A bar chart, not a line: the gaps between event days matter. */
function Trend({ days }) {
  const series = densify(days);
  const max = Math.max(...series.map((d) => d.leads), 1);
  const total = series.reduce((n, d) => n + d.leads, 0);

  if (!total) {
    return <p className="hint">No captures in the last 30 days — the chart fills in once the stall opens.</p>;
  }

  const fmt = (k) => new Date(k).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

  return (
    <>
      <div className="sparkrow" role="img" aria-label={`Leads per day over the last 30 days, peak ${max} in one day`}>
        {series.map((d) => (
          <i
            key={d.day}
            style={{
              height: `${Math.max(2, (d.leads / max) * 100)}%`,
              opacity: d.leads ? 1 : 0.22,
            }}
            title={`${fmt(d.day)}: ${d.leads}`}
          />
        ))}
      </div>
      <div className="row-between hint" style={{ marginTop: 6 }}>
        <span>{fmt(series[0].day)}</span>
        <span>peak {max}/day · {total} in 30 days</span>
        <span>{fmt(series[series.length - 1].day)}</span>
      </div>
    </>
  );
}

function Ranked({ rows, labelKey, valueKey, empty, hrefFor }) {
  if (!rows?.length) return <p className="hint">{empty}</p>;
  const max = Math.max(...rows.map((r) => r[valueKey]), 1);
  return (
    <div className="stack" style={{ gap: 9 }}>
      {rows.map((r, i) => {
        const label = r[labelKey];
        const href = hrefFor?.(r);
        return (
          <div key={`${label}-${i}`}>
            <div className="row-between" style={{ fontSize: '.86rem', marginBottom: 3 }}>
              <span>{href ? <Link href={href}>{label}</Link> : label}</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{r[valueKey]}</b>
            </div>
            <div className="bar"><i style={{ width: `${(r[valueKey] / max) * 100}%` }} /></div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/stats/overview').then(setData).catch((e) => setError(humanise(e)));
  }, []);

  if (error) return <div className="banner banner-err">{error}</div>;
  if (!data) return <p className="hint">Loading…</p>;

  const t = data.totals || {};
  const saveRate = t.total_scans ? Math.round((t.contacts_saved / t.total_scans) * 100) : null;

  return (
    <>
      <header>
        <h1>Dashboard</h1>
        <p>Live numbers for the stall. All times are IST.</p>
      </header>

      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Leads captured" value={t.leads} sub={`${t.leads_today || 0} today`} />
        <Stat
          label="Needs review"
          value={t.needs_review}
          sub={t.needs_review ? 'OCR was unsure — check these' : 'all clear'}
          tone={t.needs_review > 0 ? 'warn' : undefined}
        />
        <Stat
          label="QR scans"
          value={t.total_scans}
          sub={saveRate != null
            ? `${t.contacts_saved || 0} saved our contact (${saveRate}%)`
            : 'nobody has scanned yet'}
        />
        <Stat
          label="WhatsApp taps"
          value={t.whatsapp_clicks}
          sub="straight from the scanned page"
        />
      </div>

      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <Stat label="Events" value={t.events} sub={`${t.active_events || 0} active`} />
        <Stat label="Contact QRs live" value={t.contacts} />
        <Stat
          label="Avg OCR confidence"
          value={t.avg_ocr_confidence != null ? `${Math.round(t.avg_ocr_confidence * 100)}%` : '—'}
          sub="character-level, per card"
        />
        <Stat
          label="Reviewed"
          value={t.leads ? `${Math.round(((t.leads - t.needs_review) / t.leads) * 100)}%` : '—'}
          sub="of all leads"
        />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3>Captures — last 30 days</h3>
        <Trend days={data.by_day} />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Leads by event</h3>
          <Ranked
            rows={data.by_event?.filter((e) => e.leads > 0)}
            labelKey="name"
            valueKey="leads"
            empty="No leads against any event yet."
            hrefFor={(r) => `/leads?event_id=${r.id}`}
          />
        </div>

        <div className="card">
          <h3>Leads by staff member</h3>
          <Ranked
            rows={data.by_staff}
            labelKey="staff"
            valueKey="leads"
            empty="Nobody has captured a card yet."
          />
        </div>

        <div className="card">
          <h3>What visitors tapped</h3>
          <Ranked
            rows={data.scans}
            labelKey="action"
            valueKey="n"
            empty="No QR scans recorded yet. Print the QR pack from an event page."
          />
        </div>

        <div className="card">
          <h3>Interest tags</h3>
          <Ranked
            rows={data.tags}
            labelKey="tag"
            valueKey="n"
            empty="Staff have not tagged any leads yet."
          />
        </div>
      </div>
    </>
  );
}
