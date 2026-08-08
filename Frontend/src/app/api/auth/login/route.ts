import { NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/lib/api-client';

/**
 * Login proxy (Docs/Frontend/NextJS.md section 3).
 *
 * The browser never sees the session token: this handler exchanges credentials with the
 * Express API server-side and stores the token it returns as an httpOnly cookie. That closes
 * the XSS-can-steal-the-token gap a localStorage-based SPA has to accept.
 */
export async function POST(request: Request) {
  let body: { email?: string; password?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 });
  }

  if (!body.email || !body.password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const upstream = await fetch(`${API_URL}/v1/dashboard/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: body.password }),
    cache: 'no-store',
  });

  if (!upstream.ok) {
    // Deliberately generic. Distinguishing "no such user" from "wrong password" would let an
    // unauthenticated caller enumerate who has a dashboard account.
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const payload = (await upstream.json()) as {
    data?: { token?: string; user?: { role?: string } };
    token?: string;
  };

  const token = payload.data?.token ?? payload.token;
  if (!token) {
    return NextResponse.json({ error: 'Sign-in succeeded but returned no session' }, { status: 502 });
  }

  const response = NextResponse.json({ ok: true, role: payload.data?.user?.role ?? 'manager' });

  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    // Secure in production only: a local http://localhost dev server would silently drop it.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Matches the backend's Better Auth session lifetime (7 days).
    maxAge: 60 * 60 * 24 * 7,
  });

  return response;
}
