'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareImage } from '../../lib/scan-queue';

/**
 * Full-screen viewfinder.
 *
 * Capture takes the best route the browser offers, in order:
 *   1. ImageCapture.takePhoto() — a true still at the sensor's photo resolution, which on
 *      Android Chrome is typically 12 MP against the video stream's 2 MP. Materially
 *      better OCR on small print.
 *   2. A canvas grab of the current video frame — works everywhere, including iOS Safari,
 *      which has never shipped ImageCapture.
 *
 * If getUserMedia is refused or unavailable the caller falls back to the OS camera app via
 * an <input capture> element, which is slower but always works.
 */
/**
 * @param {object} props
 * @param {'front'|'back'} props.step   which side is being shot; drives every label
 * @param {number} props.cardNo         1-based number of the card in today's run
 * @param {Function} [props.onSkipBack] called when the back is genuinely blank
 */
export default function Camera({
  onCaptured, onClose, onCameraFailed, onSkipBack, step = 'front', cardNo = 1,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState(null);     // {blob, url}
  const [error, setError] = useState(null);
  const [facing, setFacing] = useState('environment');
  const [canFlip, setCanFlip] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onCameraFailed?.('no_api');
        return;
      }
      // Ask for plenty of resolution; the browser clamps to what the sensor can do.
      const size = { width: { ideal: 2560 }, height: { ideal: 1440 } };

      /**
       * `exact`, not `ideal`.
       *
       * `ideal` is only a preference, and iOS Safari routinely ignores it and hands back
       * the selfie camera — which produces a fixed-focus photo of the person holding the
       * card, at arm's length, with the card too small and blurred to read. The capture
       * then succeeds and the lead arrives empty, which looks like the app is broken
       * rather than like the wrong lens was used.
       *
       * `exact` fails loudly instead, and a device with only one camera (a laptop) falls
       * back to whatever it has.
       */
      async function open(mode) {
        try {
          return await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: mode }, ...size }, audio: false,
          });
        } catch (err) {
          if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
          return navigator.mediaDevices.getUserMedia({
            video: { facingMode: mode, ...size }, audio: false,
          });
        }
      }

      try {
        const stream = await open(facing);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        trackRef.current = stream.getVideoTracks()[0];
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);

        // Only offer the flip control when there really is more than one camera.
        navigator.mediaDevices.enumerateDevices?.()
          .then((ds) => setCanFlip(ds.filter((d) => d.kind === 'videoinput').length > 1))
          .catch(() => {});
      } catch (err) {
        // NotAllowedError means the person said no; NotFoundError means no camera.
        // Either way the OS-camera fallback is the useful answer, not an error page.
        onCameraFailed?.(err.name || 'error');
      }
    })();

    return () => { cancelled = true; stop(); };
  }, [facing, onCameraFailed, stop]);

  const isBack = step === 'back';

  // Release the camera when the tab is hidden — otherwise the indicator stays lit and
  // some phones keep the sensor powered, which matters when a stall phone is at 20%.
  useEffect(() => {
    function onVisibility() {
      if (document.hidden) streamRef.current?.getVideoTracks().forEach((t) => t.enabled = false);
      else streamRef.current?.getVideoTracks().forEach((t) => t.enabled = true);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  async function grabFrame() {
    const track = trackRef.current;

    if (window.ImageCapture && track) {
      try {
        const cap = new window.ImageCapture(track);
        const photo = await cap.takePhoto();
        if (photo && photo.size > 0) return photo;
      } catch {
        // Several Android builds advertise ImageCapture and then throw; fall through.
      }
    }

    const video = videoRef.current;
    if (!video || !video.videoWidth) throw new Error('video_not_ready');

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), 'image/jpeg', 0.92);
    });
  }

  async function capture() {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const raw = await grabFrame();
      const { blob } = await prepareImage(raw);
      setShot({ blob, url: URL.createObjectURL(blob) });
    } catch {
      setError('Could not take the photo. Try again, or use your phone camera.');
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    if (shot?.url) URL.revokeObjectURL(shot.url);
    setShot(null);
  }

  async function keep(mode) {
    if (!shot) return;
    setBusy(true);
    setError(null);
    try {
      await onCaptured(shot.blob, { mode });
      discard();
    } catch (err) {
      // Without this the button silently does nothing, which reads as "the app is
      // broken" rather than "saving failed" — the worst possible failure at a stall,
      // because staff keep shooting cards that are never stored.
      const why = err?.message || String(err);
      setError(
        why.includes('indexeddb') || err?.name === 'InvalidStateError'
          ? 'Could not save on this phone. If you are in Private Browsing, switch to a normal tab.'
          : `Could not save: ${why}. The photo is still on screen — try Keep again.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-cam">
      {!shot && <video ref={videoRef} playsInline muted autoPlay />}
      {shot && <img className="shot" src={shot.url} alt="The card you just photographed" />}

      {!shot && (
        <>
          <div className="sc-step">
            <b>{isBack ? 'BACK OF CARD' : 'FRONT OF CARD'}</b>
            <span>
              {isBack ? 'Step 2 of 2 — the side with the address' : `Step 1 of 2 · card ${cardNo}`}
            </span>
            <div className="sc-pips">
              <i data-done={isBack} data-on={!isBack} />
              <i data-on={isBack} />
            </div>
          </div>

          <div className="sc-guide">
            <div className="box"><i /><i /><i /><i /></div>
            <p>
              {!ready ? 'Starting camera…'
                : facing === 'user' ? 'Front camera — tap Flip for the back camera'
                : 'Fill this box with the card'}
            </p>
          </div>
        </>
      )}

      {!shot ? (
        <div className="sc-cambar">
          <button type="button" className="side" onClick={() => { stop(); onClose(); }}>Close</button>
          <button
            type="button"
            className="sc-shutter"
            onClick={capture}
            disabled={!ready || busy}
            aria-label="Take photo"
          >
            <i />
          </button>
          {isBack && onSkipBack ? (
            <button type="button" className="side" style={{ textAlign: 'right' }}
                    onClick={onSkipBack}>
              Blank
            </button>
          ) : canFlip ? (
            <button
              type="button"
              className="side"
              style={{ textAlign: 'right' }}
              onClick={() => { setReady(false); setFacing((f) => (f === 'environment' ? 'user' : 'environment')); }}
            >
              Flip
            </button>
          ) : <span className="side" />}
        </div>
      ) : (
        <div className="sc-confirm">
          <p>
            {error || (isBack
              ? 'Address and GSTIN readable?'
              : 'Name, phone and email readable?')}
          </p>
          <div className="row2">
            <button type="button" className="btn-ghost" onClick={discard} disabled={busy}>Retake</button>
            <button type="button" onClick={() => keep('next')} disabled={busy}>
              {busy ? 'Saving…' : isBack ? 'Finish card' : 'Next: the back →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
