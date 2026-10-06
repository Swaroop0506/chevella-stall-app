// Transparent proxy to cf-api.
//
// Why proxy instead of calling cf-api from the browser: the session is an httpOnly cookie,
// and a cookie cannot be shared across two origins without SameSite=None + HTTPS + CORS
// credentials on every call. Routing through Next means the browser only ever talks to one
// origin, cf-api never has to be exposed to the internet, and there is exactly one URL to
// put behind TLS when this is deployed.

const API = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(/\/+$/, '');

// Hop-by-hop and length headers must not be forwarded; fetch recomputes them.
const STRIP_REQUEST = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'upgrade', 'proxy-authorization', 'te', 'trailer', 'accept-encoding',
]);
const STRIP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
]);

async function forward(req, { params }) {
  const { path } = await params;
  const target = `${API}/api/v1/${(path || []).join('/')}${new URL(req.url).search}`;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (!STRIP_REQUEST.has(k.toLowerCase())) headers.set(k, v);
  }
  // Let the API build correct absolute URLs and rate-limit on the real client IP.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) headers.set('x-forwarded-for', fwd);

  const init = { method: req.method, headers, redirect: 'manual' };

  if (!['GET', 'HEAD'].includes(req.method)) {
    // Stream the body through untouched — this is how multipart card uploads stay intact.
    init.body = req.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return Response.json(
      { error: 'api_unreachable', detail: `cf-api at ${API} did not respond: ${err.message}` },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (!STRIP_RESPONSE.has(k.toLowerCase())) out.append(k, v);
  }
  // getSetCookie keeps multiple Set-Cookie headers separate instead of comma-joining them.
  const cookies = upstream.headers.getSetCookie?.() || [];
  if (cookies.length) {
    out.delete('set-cookie');
    for (const c of cookies) out.append('set-cookie', c);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
