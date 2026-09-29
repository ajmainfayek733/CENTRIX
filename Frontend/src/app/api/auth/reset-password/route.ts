import { NextResponse } from 'next/server';
import { malformedJsonResponse, proxyPublicPost } from '@/lib/auth-proxy';

const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: Request) {
  let body: { email?: string; token?: string; newPassword?: string };

  try {
    body = await request.json();
  } catch {
    return malformedJsonResponse();
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!email || !token || !newPassword) {
    return NextResponse.json(
      { error: 'Email, verification code, and new password are required.' },
      { status: 400 },
    );
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters long.` },
      { status: 400 },
    );
  }

  return proxyPublicPost(
    '/v1/dashboard/auth/reset-password',
    { email, token, newPassword },
    'Failed to reset password.',
  );
}
