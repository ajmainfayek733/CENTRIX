import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route gate.
 *
 * This is UX, not the security boundary. The Express API re-checks authentication and RBAC on
 * every request regardless — this only spares a manager the round trip to a settings page that
 * would 403 anyway, and sends a signed-out user to /login instead of an empty dashboard.
 *
 * It deliberately only checks for the *presence* of the session cookie, not its validity:
 * the token is an opaque Better Auth session id with nothing to decode, and verifying it
 * would mean an API call on every navigation. An expired-but-present cookie falls through to
 * the layout, which resolves the real session and redirects.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get('session')?.value);

  if (pathname === '/login') {
    return hasSession ? NextResponse.redirect(new URL('/overview', request.url)) : NextResponse.next();
  }

  if (!hasSession) {
    const login = new URL('/login', request.url);
    // Preserve where they were headed so login can return them there.
    if (pathname !== '/') login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets and the API proxy routes, which handle their own auth.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
