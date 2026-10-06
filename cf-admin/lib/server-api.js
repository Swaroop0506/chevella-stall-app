// Server-side calls to cf-api, used by the public contact page so the visitor's phone
// gets fully-rendered HTML on the first paint. A QR scan should show something instantly,
// not a loading spinner on venue wifi.

const API = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(/\/+$/, '');

export async function serverGet(path, { headers = {} } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    headers: { accept: 'application/json', ...headers },
    cache: 'no-store',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error;
    throw err;
  }
  return json;
}
