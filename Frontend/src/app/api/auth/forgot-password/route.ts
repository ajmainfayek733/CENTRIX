import { NextResponse } from 'next/server';
import { malformedJsonResponse, proxyPublicPost } from '@/lib/auth-proxy';

export async function POST(request: Request) {
  let body: { email?: string };

  try {
    body = await request.json();
  } catch {
    return malformedJsonResponse();
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) {
    return NextResponse.json({ error: 'Email address is required.' }, { status: 400 });
  }

  return proxyPublicPost(
    '/v1/dashboard/auth/forgot-password',
    { email },
    'Failed to process password recovery request.',
  );
}
