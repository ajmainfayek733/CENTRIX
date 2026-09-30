import { NextResponse } from 'next/server';
import { malformedJsonResponse, proxyPublicPost } from '@/lib/auth-proxy';

const MIN_PASSWORD_LENGTH = 8;

export async function POST(request: Request) {
  let body: { token?: string; newPassword?: string };

  try {
    body = await request.json();
  } catch {
    return malformedJsonResponse();
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!token || !newPassword) {
    return NextResponse.json(
      { error: 'Recovery token and new password are required.' },
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
    { token, newPassword },
    'Failed to reset password.',
  );
}
