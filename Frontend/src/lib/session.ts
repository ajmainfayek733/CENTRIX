import { cookies } from 'next/headers';
import { ApiUnavailableError, serverFetch, SESSION_COOKIE } from './api-client';

export type UserRole = 'super_admin' | 'manager' | 'auditor';

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  isActive: boolean;
}

/**
 * Resolves the current user by asking the API, not by decoding the token.
 *
 * The session cookie holds a Better Auth session token, which is an opaque identifier rather
 * than a JWT - there are no claims in it to read. That is a feature here: role comes from the
 * server on every request, so revoking a session or demoting a user takes effect immediately
 * instead of when a cached token expires.
 */
/**
 * @returns the signed-in user, or null when there is genuinely no valid session.
 * @throws ApiUnavailableError when the monitoring service could not be reached.
 *
 * The distinction is the whole point. This used to swallow every failure into `null`, which the
 * layout reads as "logged out" and answers with a redirect to /login. So an API restart signed
 * out every open dashboard in the building and sent them to a page that could not log them back
 * in either - an outage presented as a credentials problem, with the actual cause nowhere on
 * screen. Unavailability now propagates so callers can say what is really wrong.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const response = await serverFetch('/v1/dashboard/auth/me');

  // A 5xx says nothing about this session - the service simply cannot answer right now.
  if (response.status >= 500) {
    throw new ApiUnavailableError(`The monitoring service returned ${response.status} for /auth/me`);
  }

  // 401/403 is a real answer: the session is over, or the account was deactivated.
  if (!response.ok) return null;

  const json = (await response.json()) as { data: SessionUser };
  return json.data ?? null;
}

/** Route groups only a super_admin may open. Mirrors the backend's own RBAC. */
export const ADMIN_ONLY_PATHS = ['/settings'];

/** Screenshots are excluded from the Auditor role by spec section 6. */
export const SCREENSHOT_ROLES: UserRole[] = ['super_admin', 'manager'];

export function canViewScreenshots(role: UserRole): boolean {
  return SCREENSHOT_ROLES.includes(role);
}
