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
function parseErrorMessage(text: string, status: number, statusText: string): string {
  if (!text) {
    if (status === 404) return "The requested item or page could not be found. Please refresh and try again.";
    if (status === 401) return "Your session has expired. Please log in again to continue.";
    if (status === 403) return "You do not have permission to perform this action. Administrator rights required.";
    if (status >= 500) return "The server encountered an issue processing your request. Please try again in a moment.";
    return `The request could not be completed (${statusText || `code ${status}`}).`;
  }

  // If the server or an upstream reverse proxy responded with HTML (e.g. 404 or 502 page)
  if (text.trim().startsWith("<") || text.includes("<!DOCTYPE") || text.includes("<html")) {
    if (status === 404) {
      return "The requested department, rule, or resource could not be found. Please refresh your page.";
    }
    if (status === 502 || status === 504) {
      return "The service is temporarily unreachable or undergoing maintenance. Please try again shortly.";
    }
    return "The server responded with an unexpected error. Please refresh the page and try again.";
  }

  // Attempt to parse JSON error message
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return humanizeMessage(parsed);
    if (parsed && typeof parsed === "object") {
      // If validation details exist (e.g. Zod error issues)
      if (Array.isArray(parsed.details) && parsed.details.length > 0) {
        const detailMsgs = (parsed.details as Array<{ message?: string }>)
          .map((d) => d?.message)
          .filter(Boolean)
          .join(". ");
        if (detailMsgs) return detailMsgs;
      }
      if (typeof parsed.error === "string") return humanizeMessage(parsed.error);
      if (typeof parsed.message === "string") return humanizeMessage(parsed.message);
    }
  } catch {
    // Plain text message
  }

  return humanizeMessage(text);
}

function humanizeMessage(msg: string): string {
  if (!msg) return "An unexpected error occurred. Please try again.";

  // Clean out technical jargon so non-technical org admins get actionable messages
  if (msg.includes("Cannot POST") || msg.includes("Cannot GET") || msg.includes("Endpoint not found")) {
    return "The requested action or server endpoint could not be found. Please refresh the page and try again.";
  }
  if (msg.includes("Unauthorized") || msg.includes("Session missing") || msg.includes("expired")) {
    return "Your session has expired or is invalid. Please log in again to continue.";
  }
  if (msg.includes("Forbidden") || msg.includes("permission") || msg.includes("requireRole")) {
    return "You do not have administrative permission to modify these settings.";
  }
  if (msg.includes("PrismaClient") || msg.includes("database") || msg.includes("Unique constraint")) {
    return "A record with this information already exists, or a database conflict occurred. Please check your inputs.";
  }
  if (msg.includes("JSON at position") || msg.includes("Expected property name")) {
    return "The submitted data was malformed. Please check your inputs and try again.";
  }

  return msg.length > 250 ? `${msg.substring(0, 250)}...` : msg;
}

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

    throw new ApiError(parseErrorMessage(body, response.status, response.statusText), response.status);
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

    throw new ApiError(parseErrorMessage(text, response.status, response.statusText), response.status);
  }

  const json = (await response.json()) as { data: T };
  return json.data;
}

export { API_URL };
