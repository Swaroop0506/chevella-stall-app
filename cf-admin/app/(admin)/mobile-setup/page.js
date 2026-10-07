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

function ShareLink({ url }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  async function copy() {
    await navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // The link embeds the device key, so it is masked until deliberately revealed —
  // this page is often open on a laptop with people standing behind it.
  const masked = url.replace(/#k=.*$/, '#k=••••••••••••');

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <input
          readOnly
          value={revealed ? url : masked}
          className="mono"
          onFocus={(e) => e.target.select()}
          style={{ flex: 1, minWidth: 220, fontSize: '.8rem' }}
          aria-label="Scanner share link"
        />
        <button type="button" className="btn-ghost btn-sm" onClick={() => setRevealed((r) => !r)}>
          {revealed ? 'Hide' : 'Show'}
        </button>
        <button type="button" onClick={copy}>{copied ? 'Copied!' : 'Copy link'}</button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        WhatsApp this to each staff member. It fills in the device key for them, so all they
        do is type their name and pick the event.
      </div>
    </>
  );
}

export default function ScannerSetup() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
    api.get('/app-config').then(setCfg).catch((e) => setError(humanise(e)));
  }, []);

  if (error) return <div className="banner banner-err">{error}</div>;
  if (!cfg) return <p className="hint">Loading…</p>;

  const apk = cfg.apk_url;
  const scanUrl = origin ? `${origin}/scan` : '/scan';
  const shareUrl = origin ? `${scanUrl}#k=${encodeURIComponent(cfg.device_api_key)}` : '';
  const insecure = origin.startsWith('http://') && !origin.includes('localhost');

  return (
    <>
      <header>
        <h1>Scanner</h1>
        <p>
          Two ways for staff to photograph visiting cards. Both feed the same lead list —
          mix and match across phones freely.
        </p>
      </header>

      {insecure && (
        <div className="banner banner-err">
          This server is on plain <b>http://</b>. Browsers only allow camera access over
          <b> https://</b>, so the web scanner cannot open the camera here. Staff can still
          use the <i>phone camera app</i> fallback — but set up HTTPS before the event.
          See DEPLOYMENT.md.
        </div>
      )}

      <div className="grid grid-2">
        {/* ------------------------------------------------ web scanner */}
        <div className="card" style={{ borderColor: 'var(--leaf)', borderWidth: 2 }}>
          <div className="row-between" style={{ marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>Web link — nothing to install</h3>
            <span className="badge badge-green">easiest</span>
          </div>
          <p className="hint">
            Opens in the phone&apos;s browser. Best when you are handing a phone to someone
            for an afternoon, or a colleague turns up unexpectedly and needs to help.
          </p>

          <div className="row" style={{ alignItems: 'flex-start', gap: 18, margin: '14px 0' }}>
            <img
              src={`/api/v1/qr.png?size=440&text=${encodeURIComponent(shareUrl || scanUrl)}`}
              alt="QR code to open the web scanner"
              width={150}
              height={150}
              style={{ border: '1px solid var(--line)', borderRadius: 8 }}
            />
            <div className="hint" style={{ flex: 1 }}>
              Staff point their camera at this code and the scanner opens, already
              connected. Nothing to download, nothing to approve.
            </div>
          </div>

          {shareUrl && <ShareLink url={shareUrl} />}

          <p className="hint" style={{ marginTop: 14 }}>
            Tell them to tap <b>Add to Home screen</b> — it then opens full screen, like an
            app, and keeps working with no signal.
          </p>
          <div className="banner banner-warn" style={{ marginTop: 10, marginBottom: 0 }}>
            One real limit: a browser only uploads while the tab is open. Staff should keep
            it open until <b>Waiting</b> shows zero. The app below has no such limit.
          </div>
        </div>

        {/* ------------------------------------------------ apk */}
        <div className="card">
          <div className="row-between" style={{ marginBottom: 4 }}>
            <h3 style={{ margin: 0 }}>Android app</h3>
            <span className="badge">most reliable</span>
          </div>
          <p className="hint">
            Worth installing on the phones that will be on the stall all three days: it
            syncs even after the app is closed, and the camera is a little faster.
          </p>

          {apk ? (
            <div className="row" style={{ alignItems: 'flex-start', gap: 18, margin: '14px 0' }}>
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
          ) : (
            <ol className="hint" style={{ paddingLeft: 20, lineHeight: 1.8 }}>
              <li>Open the repo&apos;s <b>Actions → Build Android APK</b> run.</li>
              <li>Download the <b>cf-scanner-apk</b> artifact, or grab it from the Release.</li>
              <li>
                Set <span className="mono">APK_DOWNLOAD_URL</span> in the API&apos;s
                environment to that link and a QR will appear here.
              </li>
            </ol>
          )}

          <p className="hint">
            Android blocks installs from outside the Play Store by default. On each phone:
            <b> Settings → Apps → Special access → Install unknown apps</b>, then allow the
            browser you are installing from.
          </p>
        </div>

        {/* ------------------------------------------------ connection details */}
        <div className="card">
          <h3>Connection details</h3>
          <p className="hint">
            The web link above carries these already. You only need them to set up the
            Android app by hand.
          </p>

          <div className="field">
            <label>API URL</label>
            <input readOnly value={cfg.api_public_url} className="mono" onFocus={(e) => e.target.select()} />
            <div className="hint">
              Must be reachable from the phones over mobile data — not a{' '}
              <span className="mono">localhost</span> address.
            </div>
          </div>

          <div className="field">
            <label>Device key</label>
            <Secret value={cfg.device_api_key} />
            <div className="hint">
              Shared by every phone. Not a user identity — it just stops strangers posting
              into your lead list. Rotate it via <span className="mono">DEVICE_API_KEY</span>{' '}
              if a phone is lost; every phone then has to be re-linked.
            </div>
          </div>

          <div className="field">
            <label>Setup QR (for the Android app)</label>
            <img
              src={`/api/v1/qr.png?size=440&text=${encodeURIComponent(
                JSON.stringify({ api: cfg.api_public_url, key: cfg.device_api_key }),
              )}`}
              alt="QR code containing the API URL and device key"
              width={150}
              height={150}
              style={{ border: '1px solid var(--line)', borderRadius: 8 }}
            />
            <div className="hint">Scan from the app&apos;s setup screen to fill both fields.</div>
          </div>
        </div>

        {/* ------------------------------------------------ how it flows */}
        <div className="card">
          <h3>How a capture flows</h3>
          <ol style={{ paddingLeft: 20, lineHeight: 1.85, margin: 0 }}>
            <li>Staff taps <b>Scan a visiting card</b> and photographs it.</li>
            <li>The photo is saved on the phone immediately — <b>no network needed</b>.</li>
            <li>When there is signal it uploads; the server runs OCR and extracts the fields.</li>
            <li>Staff can add interest tags and a note, then move to the next visitor.</li>
            <li>Anything OCR was unsure about lands in <b>Leads → Needs review</b> here.</li>
          </ol>
          <p className="hint" style={{ marginTop: 12 }}>
            Venue wifi is usually terrible, which is why the queue exists. A phone can scan
            a hundred cards with no signal at all and sync later.
          </p>
        </div>

        <div className="card">
          <h3>Getting the most out of OCR</h3>
          <p className="hint">
            The engine is PP-OCRv5, the strongest freely-licensed OCR available, and the
            service reads each photo six times at different exposures and keeps the best
            result. It is still OCR, so a human confirms anything it was unsure about.
          </p>
          <ul style={{ paddingLeft: 20, lineHeight: 1.75, margin: 0 }}>
            <li>Fill the frame with the card — the guide box shows where.</li>
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
