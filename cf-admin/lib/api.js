'use client';

/** Browser-side API helper. Always same-origin — the Next route handler proxies to cf-api. */

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const MESSAGES = {
  invalid_credentials: 'That email and password combination did not work.',
  not_authenticated: 'Your session has expired. Please sign in again.',
  session_expired: 'Your session has expired. Please sign in again.',
  too_many_attempts: 'Too many sign-in attempts. Wait ten minutes and try again.',
  bad_phone: 'That phone number does not look valid. Enter 10 digits, e.g. 9701221934.',
  bad_whatsapp: 'That WhatsApp number does not look valid.',
  missing_name: 'A name is required.',
  event_has_leads: 'This event already has captured leads. Archive it instead of deleting.',
  vcard_too_large: 'Too much data for a direct-vCard QR — use the page QR instead.',
  api_unreachable: 'The API is not responding. Check that cf-api is running.',
  file_too_large: 'That image is too large.',
  conflict: 'That already exists.',
};

export function humanise(err) {
  if (!(err instanceof ApiError)) return err?.message || 'Something went wrong.';
  return MESSAGES[err.code] || err.detail || MESSAGES[err.code] || `Request failed (${err.status}).`;
}

async function request(method, path, body, opts = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };

  if (body instanceof FormData) {
    init.body = body;                      // let the browser set the multipart boundary
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`/api/v1${path}`, init);

  if (opts.raw) return res;

  if (res.status === 204) return null;

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

  if (!res.ok) {
    throw new ApiError(res.status, json?.error, json?.detail || text?.slice(0, 200));
  }
  return json;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),

  /** Triggers a browser download for an endpoint that returns a file. */
  async download(path, fallbackName = 'download') {
    const res = await request('GET', path, undefined, { raw: true });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.detail || ''; } catch { /* ignore */ }
      throw new ApiError(res.status, 'download_failed', detail);
    }
    const blob = await res.blob();
    const disp = res.headers.get('content-disposition') || '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
    const name = match ? decodeURIComponent(match[1]) : fallbackName;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return name;
  },
};

/** "+919701221934" -> "+91 97012 21934" */
export function prettyPhone(e164) {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164 || '');
  return m ? `+91 ${m[1]} ${m[2]}` : e164 || '';
}

const IST = 'Asia/Kolkata';

export function istDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export function istDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function relative(value) {
  if (!value) return '—';
  const secs = (Date.now() - new Date(value).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)} d ago`;
  return istDate(value);
}
