import { cookies } from 'next/headers';
import { serverFetch, SESSION_COOKIE } from './api-client';

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
 * than a JWT — there are no claims in it to read. That is a feature here: role comes from the
 * server on every request, so revoking a session or demoting a user takes effect immediately
 * instead of when a cached token expires.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const response = await serverFetch('/v1/dashboard/auth/me');
    if (!response.ok) return null;

    const json = (await response.json()) as { data: SessionUser };
    return json.data ?? null;
  } catch {
    // The API being down must not render the dashboard as "logged out" incorrectly, but there
    // is nothing useful to show without it either — treat as unauthenticated and let the
    // layout redirect to /login, where the failure is visible.
    return null;
  }
}

/** Route groups only a super_admin may open. Mirrors the backend's own RBAC. */
export const ADMIN_ONLY_PATHS = ['/settings'];

/** Screenshots are excluded from the Auditor role by spec section 6. */
export const SCREENSHOT_ROLES: UserRole[] = ['super_admin', 'manager'];

export function canViewScreenshots(role: UserRole): boolean {
  return SCREENSHOT_ROLES.includes(role);
}
