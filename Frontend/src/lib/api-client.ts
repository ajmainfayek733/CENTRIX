import { cookies } from 'next/headers';

/**
 * Server-side client for the Express monitoring API.
 *
 * This file must never be imported by a client component. The session token lives in an
 * httpOnly cookie and is attached here, on the server - a client component that built its own
 * Authorization header would need the token in browser-readable storage, which is exactly the
 * XSS exposure the httpOnly cookie exists to close (Docs/frontend/session-and-auth.md).
 */

export const SESSION_COOKIE = 'session';

const API_URL = process.env.MONITORING_API_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/**
 * The monitoring API could not be reached, or failed in a way that says nothing about this
 * request: connection refused, DNS failure, timeout, 502/503/504, or a 500.
 *
 * Kept distinct from ApiError because the two demand opposite responses and confusing them
 * produces the worst possible behaviour. A 401 means this session is over and the user should be
 * sent to /login. An unreachable backend means nothing about the session - and redirecting to
 * /login for it logs out every working user the moment the API restarts, lands them on a page
 * that cannot authenticate them either, and presents an infrastructure outage as though they had
 * done something wrong.
 */
export class ApiUnavailableError extends Error {
  constructor(
    message: string,
    /** Underlying failure, kept for the server log. Never shown to the user. */
    public readonly reason?: unknown
  ) {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

/** Statuses that mean "this server cannot serve right now", as opposed to "your request was bad". */
function isUnavailableStatus(status: number): boolean {
  return status >= 500;
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  try {
    return await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // Not optional. Next caches fetch aggressively by default, and a cached read would show a
      // manager yesterday's "who is online now" - the one thing this dashboard exists to answer.
      cache: 'no-store',
    });
  } catch (error) {
    // fetch rejects only for transport-level failures - the API being down, unresolvable or
    // unreachable. An HTTP error status resolves normally and is classified by the callers below.
    throw new ApiUnavailableError(`Could not reach the monitoring service at ${API_URL}`, error);
  }
}

/**
 * Fetches and unwraps the API's `{ data }` envelope.
 *
 * A 401 here means the session expired mid-render. It is surfaced as a typed error rather
 * than a redirect because redirect() cannot be called from every context this runs in; the
 * dashboard layout catches it and sends the user to /login.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const response = await serverFetch(path);

  if (!response.ok) {
    const body = await response.text();

    if (isUnavailableStatus(response.status)) {
      throw new ApiUnavailableError(
        `The monitoring service returned ${response.status} for ${path}`,
        body
      );
    }

    throw new ApiError(body || response.statusText, response.status);
  }

  const json = (await response.json()) as { data: T };
  return json.data;
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await serverFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();

    if (isUnavailableStatus(response.status)) {
      throw new ApiUnavailableError(
        `The monitoring service returned ${response.status} for ${path}`,
        text
      );
    }

    throw new ApiError(text || response.statusText, response.status);
  }

  const json = (await response.json()) as { data: T };
  return json.data;
}

export { API_URL };
