import { NextResponse } from 'next/server';
import { serverFetch, SESSION_COOKIE } from '@/lib/api-client';

/**
 * Clears the session both server-side and in the browser.
 *
 * The upstream revocation is attempted first but its failure does not block the cookie being
 * cleared: a user who clicked "sign out" must end up signed out of this browser even if the
 * API is unreachable.
 */
export async function POST() {
  try {
    await serverFetch('/api/auth/sign-out', { method: 'POST' });
  } catch {
    // Ignored on purpose - see above.
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: SESSION_COOKIE, value: '', path: '/', maxAge: 0 });
  return response;
}
