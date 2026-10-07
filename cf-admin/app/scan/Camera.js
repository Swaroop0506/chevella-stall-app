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
export default function Camera({ onCaptured, onClose, onCameraFailed }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState(null);     // {blob, url}
  const [error, setError] = useState(null);

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
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // Ask for plenty; the browser clamps to what the sensor can do.
            width: { ideal: 2560 },
            height: { ideal: 1440 },
            focusMode: { ideal: 'continuous' },
          },
          audio: false,
        });
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
      } catch (err) {
        // NotAllowedError means the person said no; NotFoundError means no camera.
        // Either way the OS-camera fallback is the useful answer, not an error page.
        onCameraFailed?.(err.name || 'error');
      }
    })();

    return () => { cancelled = true; stop(); };
  }, [onCameraFailed, stop]);

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

  async function keep(andAnnotate) {
    if (!shot) return;
    setBusy(true);
    try {
      await onCaptured(shot.blob, { annotate: andAnnotate });
      discard();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-cam">
      {!shot && <video ref={videoRef} playsInline muted autoPlay />}
      {shot && <img className="shot" src={shot.url} alt="The card you just photographed" />}

      {!shot && (
        <div className="sc-guide">
          <div className="box"><i /><i /><i /><i /></div>
          <p>{ready ? 'Fill this box with the card' : 'Starting camera…'}</p>
        </div>
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
          <span className="side" />
        </div>
      ) : (
        <div className="sc-confirm">
          <p>{error || 'Readable? Check the phone number and email are sharp.'}</p>
          <div className="row2">
            <button type="button" className="btn-ghost" onClick={discard} disabled={busy}>Retake</button>
            <button type="button" onClick={() => keep(false)} disabled={busy}>
              {busy ? 'Saving…' : 'Keep & next'}
            </button>
          </div>
          <button type="button" className="later" onClick={() => keep(true)} disabled={busy}>
            Keep and add a note / interest →
          </button>
        </div>
      )}
    </div>
  );
}
