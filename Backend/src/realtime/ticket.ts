import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/**
 * Short-lived tickets that authenticate a dashboard's Socket.IO handshake.
 *
 * WHY NOT JUST SEND THE SESSION TOKEN: the dashboard keeps its Better Auth session in an
 * httpOnly cookie precisely so that a script on the page cannot read it (Docs/Frontend/NextJS.md
 * §3). A Socket.IO handshake runs in the browser, so handing it the session token would mean
 * putting that token somewhere JavaScript can reach — undoing the one protection the httpOnly
 * cookie provides, in exchange for a live-updates feature.
 *
 * A ticket is the narrow alternative. The Next.js server, which *can* read the cookie, exchanges
 * it for one of these; the browser receives only the ticket. It is signed rather than stored, so
 * there is no table to sweep, and it is deliberately useless for anything but opening a socket:
 *
 *   • it expires in seconds, not days, so a leaked one is stale before it is useful;
 *   • the REST API does not accept it, so it cannot read or write anything;
 *   • it carries no secret — only the user id and role, which the socket needs for its rooms
 *     and its admin check.
 *
 * Signed with BETTER_AUTH_SECRET so an attacker cannot mint one; verification is constant-time so
 * the comparison cannot be used as an oracle.
 */

/**
 * Ticket lifetime. Long enough to survive a slow page load and a reconnect attempt, short enough
 * that one captured from a log or a proxy is worthless by the time anyone looks at it.
 */
const TICKET_TTL_MS = 60_000;

/** Field separator. Not valid in a uuid or a role name, so it cannot appear inside a field. */
const FIELD_SEPARATOR = '.';

export interface TicketClaims {
  userId: string;
  role: string;
}

function sign(payload: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(payload).digest('base64url');
}

export function issueRealtimeTicket(claims: TicketClaims): { ticket: string; expiresInMs: number } {
  const expiresAt = Date.now() + TICKET_TTL_MS;
  const payload = [claims.userId, claims.role, expiresAt].join(FIELD_SEPARATOR);

  return {
    ticket: `${payload}${FIELD_SEPARATOR}${sign(payload)}`,
    expiresInMs: TICKET_TTL_MS,
  };
}

/**
 * Verifies a ticket and returns its claims, or null if it is forged, malformed or expired.
 *
 * Returns null rather than throwing for every failure mode, and the caller reports one generic
 * error: distinguishing "expired" from "bad signature" to an unauthenticated peer tells an
 * attacker which half of their guess was right.
 */
export function verifyRealtimeTicket(ticket: unknown): TicketClaims | null {
  if (typeof ticket !== 'string') return null;

  const parts = ticket.split(FIELD_SEPARATOR);
  if (parts.length !== 4) return null;

  const [userId, role, expiresAtRaw, signature] = parts as [string, string, string, string];
  const payload = [userId, role, expiresAtRaw].join(FIELD_SEPARATOR);

  const expected = Buffer.from(sign(payload));
  const presented = Buffer.from(signature);

  // Length is checked first because timingSafeEqual throws on a mismatch — and the length of a
  // base64url HMAC is fixed and public, so leaking it reveals nothing.
  if (expected.length !== presented.length) return null;
  if (!timingSafeEqual(expected, presented)) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  return { userId, role };
}
