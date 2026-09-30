import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/api-client';

const UNAVAILABLE_MESSAGE =
  'The monitoring service is unavailable. Your request has not been processed. Try again shortly.';

export function malformedJsonResponse() {
  return NextResponse.json({ error: 'Malformed request payload' }, { status: 400 });
}

export function serviceUnavailableResponse() {
  return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 503 });
}

function upstreamErrorMessage(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.error === 'string' && data.error.trim()) return data.error;
  if (typeof data.message === 'string' && data.message.trim()) return data.message;
  return fallback;
}

/**
 * Forwards an unauthenticated auth/onboarding POST to the Express API.
 * 5xx from upstream is reported as unavailable, not as a form validation failure.
 */
export async function proxyPublicPost(
  path: string,
  body: unknown,
  fallbackError: string,
): Promise<NextResponse> {
  if (!API_URL) {
    return serviceUnavailableResponse();
  }

  try {
    const upstream = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (upstream.status >= 500) {
      console.error(`${path}: monitoring service returned ${upstream.status}`);
      return serviceUnavailableResponse();
    }

    if (!upstream.ok) {
      return NextResponse.json(
        { error: upstreamErrorMessage(data, fallbackError) },
        { status: upstream.status },
      );
    }

    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    console.error(`${path}: monitoring service unreachable:`, error);
    return serviceUnavailableResponse();
  }
}
