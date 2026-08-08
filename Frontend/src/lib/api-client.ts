import { cookies } from 'next/headers';

/**
 * Server-side client for the Express monitoring API.
 *
 * This file must never be imported by a client component. The session token lives in an
 * httpOnly cookie and is attached here, on the server — a client component that built its own
 * Authorization header would need the token in browser-readable storage, which is exactly the
 * XSS exposure the httpOnly cookie exists to close (Docs/Frontend/NextJS.md section 3).
 */

export const SESSION_COOKIE = 'session';

const API_URL = process.env.MONITORING_API_URL ?? 'http://localhost:5000';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // Not optional. Next caches fetch aggressively by default, and a cached read would show a
    // manager yesterday's "who is online now" — the one thing this dashboard exists to answer.
    cache: 'no-store',
  });
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
    throw new ApiError(text || response.statusText, response.status);
  }

  const json = (await response.json()) as { data: T };
  return json.data;
}

export { API_URL };
