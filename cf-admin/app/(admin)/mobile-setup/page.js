'use client';

import { useEffect, useState } from 'react';
import { api, humanise } from '../../../lib/api';

function Secret({ value }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <input
        readOnly
        value={shown ? value : '•'.repeat(Math.min(32, value.length))}
        className="mono"
        onFocus={(e) => e.target.select()}
        style={{ flex: 1, minWidth: 180 }}
        aria-label="Device API key"
      />
      <button type="button" className="btn-ghost btn-sm" onClick={() => setShown((s) => !s)}>
        {shown ? 'Hide' : 'Show'}
      </button>
      <button type="button" className="btn-ghost btn-sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function MobileSetup() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/app-config').then(setCfg).catch((e) => setError(humanise(e)));
  }, []);

  if (error) return <div className="banner banner-err">{error}</div>;
  if (!cfg) return <p className="hint">Loading…</p>;

  const apk = cfg.apk_url;

  return (
    <>
      <header>
        <h1>Scanner app</h1>
        <p>
          The Android app the stall staff use to photograph visiting cards. No login — they
          pick an event, type their first name once, and start scanning.
        </p>
      </header>

      <div className="grid grid-2">
        <div className="card">
          <h3>1 · Install the APK</h3>
          {apk ? (
            <>
              <p className="hint">Open this on each phone, or scan the code with the phone&apos;s camera.</p>
              <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
                <img
                  src={`/api/v1/qr.png?size=440&text=${encodeURIComponent(apk)}`}
                  alt="QR code to download the scanner APK"
                  width={150}
                  height={150}
                  style={{ border: '1px solid var(--line)', borderRadius: 8 }}
                />
                <div>
                  <a className="btn" href={apk}>Download APK</a>
                  <p className="qr-url" style={{ marginTop: 8 }}>{apk}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <p>
                No APK URL is configured yet. The GitHub Actions workflow in this repo builds
                a signed-for-debug APK on every push and attaches it to the run.
              </p>
              <ol className="hint" style={{ paddingLeft: 20, lineHeight: 1.7 }}>
                <li>Open the repo&apos;s <b>Actions → Build Android APK</b> run.</li>
                <li>Download the <b>cf-scanner-apk</b> artifact, or grab it from the Release.</li>
                <li>Set <span className="mono">APK_DOWNLOAD_URL</span> in the API&apos;s environment to
                    that link, and a QR code will appear here.</li>
              </ol>
            </>
          )}
          <p className="hint">
            Android blocks installs from outside the Play Store by default. On each phone:
            <b> Settings → Apps → Special access → Install unknown apps</b>, then allow the
            browser or file manager you are installing from.
          </p>
        </div>

        <div className="card">
          <h3>2 · Point the app at this server</h3>
          <p className="hint">
            Typed into the app&apos;s setup screen once per phone. Both values are also baked in
            as defaults when the APK is built from this repo.
          </p>

          <div className="field">
            <label>API URL</label>
            <input readOnly value={cfg.api_public_url} className="mono" onFocus={(e) => e.target.select()} />
            <div className="hint">
              Must be reachable from the phones over mobile data — not a <span className="mono">localhost</span> address.
            </div>
          </div>

          <div className="field">
            <label>Device key</label>
            <Secret value={cfg.device_api_key} />
            <div className="hint">
              Shared by every phone. It is not a user identity — it just stops strangers
              posting into your lead list. Rotate it in the API&apos;s environment
              (<span className="mono">DEVICE_API_KEY</span>) if a phone is lost.
            </div>
          </div>

          <div className="field">
            <label>Setup QR</label>
            <img
              src={`/api/v1/qr.png?size=440&text=${encodeURIComponent(
                JSON.stringify({ api: cfg.api_public_url, key: cfg.device_api_key }),
              )}`}
              alt="QR code containing the API URL and device key"
              width={150}
              height={150}
              style={{ border: '1px solid var(--line)', borderRadius: 8 }}
            />
            <div className="hint">
              Scan this from the app&apos;s setup screen to fill both fields without typing.
            </div>
          </div>
        </div>

        <div className="card">
          <h3>3 · How a capture flows</h3>
          <ol style={{ paddingLeft: 20, lineHeight: 1.85, margin: 0 }}>
            <li>Staff taps <b>Scan card</b> and photographs the visiting card.</li>
            <li>The photo is queued on the phone immediately — <b>no network needed</b>.</li>
            <li>When there is signal it uploads; the server runs OCR and extracts the fields.</li>
            <li>Staff can add interest tags and a note, then move to the next visitor.</li>
            <li>Anything OCR was unsure about lands in <b>Leads → Needs review</b> here.</li>
          </ol>
          <p className="hint" style={{ marginTop: 12 }}>
            Venue wifi is usually terrible, which is why the queue exists. A phone can scan
            a hundred cards with no signal at all and sync on the drive home.
          </p>
        </div>

        <div className="card">
          <h3>Getting the most out of OCR</h3>
          <p className="hint">
            The engine is PP-OCRv5, the strongest freely-licensed OCR available, and the
            service reads each photo several times at different exposures and keeps the best
            result. It is still OCR, so a human confirms anything it was unsure about.
          </p>
          <ul style={{ paddingLeft: 20, lineHeight: 1.75, margin: 0 }}>
            <li>Fill the frame with the card — the guide box in the app shows where.</li>
            <li>Flat on the counter beats held in the air.</li>
            <li>Avoid shooting straight into a spotlight; glossy cards blow out.</li>
            <li>Tap to focus and wait for it to settle before pressing the shutter.</li>
            <li>Double-sided card? Shoot the side with the phone number.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
