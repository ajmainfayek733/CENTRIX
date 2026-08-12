import { NextResponse } from 'next/server';
import { apiSend } from '@/lib/api-client';

/**
 * Mints a Socket.IO handshake ticket for the current session.
 *
 * This route exists so the browser never touches the session token. The token lives in an
 * httpOnly cookie that only the server can read (Docs/Frontend/NextJS.md §3); this handler reads
 * it, exchanges it at the API for a short-lived ticket that can do nothing but open a socket, and
 * returns only that. Handing the session token to the client instead would have undone the whole
 * point of the httpOnly cookie for the sake of live updates.
 */
export async function POST() {
  try {
    const data = await apiSend<{ ticket: string; expiresInMs: number }>(
      '/v1/dashboard/auth/realtime-ticket',
      'POST'
    );
    return NextResponse.json(data);
  } catch {
    // No detail in the response: an unauthenticated caller learns only that it failed. The
    // client treats any failure as "no live updates" and falls back to its normal fetches.
    return NextResponse.json({ error: 'Unable to issue a realtime ticket' }, { status: 401 });
  }
}
