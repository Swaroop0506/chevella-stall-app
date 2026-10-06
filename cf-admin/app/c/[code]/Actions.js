'use client';

import { useState } from 'react';

/**
 * The tappable part of the contact page.
 *
 * Tracking uses sendBeacon where available: a normal fetch races the navigation the tap
 * triggers, and browsers cancel in-flight requests when the page unloads — so WhatsApp
 * taps would simply never be counted.
 */
export default function Actions({ code, vcardUrl, waLink, phone, website, name }) {
  const [saved, setSaved] = useState(false);

  function track(action) {
    try {
      const body = JSON.stringify({ action });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          `/api/v1/public/c/${code}/track`,
          new Blob([body], { type: 'application/json' }),
        );
        return;
      }
      fetch(`/api/v1/public/c/${code}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Never let analytics get in the way of the tap.
    }
  }

  return (
    <>
      {/* A plain <a download> rather than JS: it is what makes iOS Safari hand the file to
          Contacts instead of rendering it as text. */}
      <a
        className="cf-save"
        href={vcardUrl}
        download={`${name.replace(/[^\w]+/g, '-')}-chevella-farms.vcf`}
        onClick={() => { track('vcard'); setSaved(true); }}
      >
        <span aria-hidden="true">↓</span>
        Save our contact
      </a>

      {waLink && (
        <a className="cf-wa" href={waLink} target="_blank" rel="noreferrer" onClick={() => track('whatsapp')}>
          <span aria-hidden="true">◆</span>
          WhatsApp us
        </a>
      )}

      <div className="cf-row2">
        <a className="cf-mini" href={`tel:${phone}`} onClick={() => track('call')}>
          <span aria-hidden="true">☎</span> Call
        </a>
        <a className="cf-mini" href={website} target="_blank" rel="noreferrer" onClick={() => track('website')}>
          <span aria-hidden="true">◈</span> Website
        </a>
      </div>

      <p className="cf-hint">
        {saved
          ? 'Downloaded. Open the file and tap Add to Contacts if your phone has not already asked.'
          : 'Tapping Save downloads a contact card your phone adds in one more tap.'}
      </p>
    </>
  );
}
