import { NextResponse } from 'next/server';
import { apiSend, ApiUnavailableError } from '@/lib/api-client';

/**
 * Mints a Socket.IO handshake ticket for the current session.
 *
 * This route exists so the browser never touches the session token. The token lives in an
 * httpOnly cookie that only the server can read (Docs/Frontend/NextJS.md section 3); this handler reads
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
  } catch (error) {
    // 503, not 401, when the service is simply unreachable. The two are not interchangeable to
    // the caller: 401 means "this session cannot have live updates", which is a reason to stop
    // asking, while 503 means "try again shortly". Answering 401 for an outage would have the
    // provider give up on a connection that was going to work a moment later.
    if (error instanceof ApiUnavailableError) {
      console.error('realtime ticket: monitoring service unreachable:', error);
      return NextResponse.json(
        { error: 'The monitoring service is unavailable' },
        { status: 503, headers: { 'retry-after': String(RETRY_AFTER_SECONDS) } }
      );
    }

    // No detail for a genuine auth failure: an unauthenticated caller learns only that it failed.
    return NextResponse.json({ error: 'Unable to issue a realtime ticket' }, { status: 401 });
  }
}

/**
 * Hint for how long to wait before retrying. Matches the provider's own minimum backoff, so a
 * client honouring the header and one using its own schedule behave the same.
 */
const RETRY_AFTER_SECONDS = 1;
