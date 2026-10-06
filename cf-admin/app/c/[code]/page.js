import Link from 'next/link';
import { serverGet } from '../../../lib/server-api';
import Actions from './Actions';
import './contact.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { code } = await params;
  try {
    const { contact } = await serverGet(`/public/c/${code}`);
    return {
      title: `${contact.name} — ${contact.company}`,
      description: `Save ${contact.name}'s contact details from ${contact.company}.`,
      robots: { index: false, follow: false },
    };
  } catch {
    return { title: 'Contact — Chevella Farms', robots: { index: false } };
  }
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function Unavailable({ heading, body }) {
  return (
    <main className="cf-page">
      <div className="cf-brand">
        <b>Chevella Farms</b>
        <span>The land of coconut goodness</span>
      </div>
      <div className="cf-gone">
        <h1>{heading}</h1>
        <p>{body}</p>
        <a className="cf-mini" href="https://www.chevellafarms.com/" style={{ marginTop: 16 }}>
          Visit chevellafarms.com
        </a>
      </div>
    </main>
  );
}

export default async function ContactPage({ params }) {
  const { code } = await params;

  let data;
  try {
    data = await serverGet(`/public/c/${code}`);
  } catch (err) {
    if (err.status === 404) {
      return (
        <Unavailable
          heading="This code isn't recognised"
          body="The QR may have been mistyped or replaced. Ask us at the stall for a fresh one."
        />
      );
    }
    if (err.status === 410) {
      return (
        <Unavailable
          heading="This contact is no longer shared"
          body="The person behind this QR code has been removed. You can still reach us through our website."
        />
      );
    }
    return (
      <Unavailable
        heading="We couldn't load this contact"
        body="Something went wrong on our side. Please try again in a moment."
      />
    );
  }

  const { contact, brand } = data;

  return (
    <main className="cf-page">
      <div className="cf-brand">
        <b>{brand.company}</b>
        <span>{brand.tagline}</span>
      </div>

      <article className="cf-card">
        <div className="cf-avatar" aria-hidden="true">{initials(contact.name)}</div>

        <h1 className="cf-name">{contact.name}</h1>
        {contact.designation && <p className="cf-role">{contact.designation}</p>}
        <p className="cf-org">{contact.company}</p>

        <div className="cf-meta">
          <a href={`tel:${contact.phone}`}>
            <span className="k">Phone</span>
            <span className="v">{contact.phone_display}</span>
          </a>

          {contact.whatsapp_reachable && contact.whatsapp !== contact.phone && (
            <a href={contact.whatsapp_link} target="_blank" rel="noreferrer">
              <span className="k">WhatsApp</span>
              <span className="v">{contact.whatsapp_display}</span>
            </a>
          )}

          {contact.email && (
            <a href={`mailto:${contact.email}`}>
              <span className="k">Email</span>
              <span className="v">{contact.email}</span>
            </a>
          )}

          {contact.address && (
            <span>
              <span className="k">Office</span>
              <span className="v">{contact.address}</span>
            </span>
          )}
        </div>

        <Actions
          code={contact.code}
          name={contact.name}
          vcardUrl={`/api/v1/public/c/${contact.code}/vcard.vcf`}
          waLink={contact.whatsapp_reachable ? contact.whatsapp_link : null}
          phone={contact.phone}
          website={contact.website_url}
        />

        {contact.event_name && (
          <p className="cf-event">
            Met at {contact.event_name}
            {contact.stall_no && ` · Stall ${contact.stall_no}`}
          </p>
        )}
      </article>

      <footer className="cf-foot">
        Instant coconut water powder · Tender coconut water · 100% vegan
        <br />
        <Link href={brand.website}>{brand.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</Link>
        {' · '}
        <a href={`mailto:${brand.email}`}>{brand.email}</a>
      </footer>
    </main>
  );
}
