import { NextResponse } from 'next/server';

// Presence-only cookie check. The signature is verified by cf-api on every request, so
// this is purely about not rendering an admin shell that is about to 401 — it is not the
// security boundary.
const COOKIE = 'cf_session';

const PUBLIC_PREFIXES = ['/c/', '/api/v1/auth/', '/api/v1/public/', '/_next', '/favicon'];

export function middleware(req) {
  const { pathname, search } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(COOKIE)?.value);

  // Already signed in and loading the form? Go straight to the dashboard.
  if (pathname === '/login') {
    if (!hasSession) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (!hasSession) {
    // API calls get a clean 401 rather than an HTML redirect the fetch cannot read.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
