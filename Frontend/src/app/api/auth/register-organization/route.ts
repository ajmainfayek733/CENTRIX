import { NextResponse } from 'next/server';
import { malformedJsonResponse, proxyPublicPost } from '@/lib/auth-proxy';

const MIN_PASSWORD_LENGTH = 8;
const MIN_NAME_LENGTH = 2;

export async function POST(request: Request) {
  let body: {
    name?: string;
    adminName?: string;
    adminEmail?: string;
    adminPassword?: string;
  };

  try {
    body = await request.json();
  } catch {
    return malformedJsonResponse();
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const adminName = typeof body.adminName === 'string' ? body.adminName.trim() : '';
  const adminEmail = typeof body.adminEmail === 'string' ? body.adminEmail.trim().toLowerCase() : '';
  const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';

  if (name.length < MIN_NAME_LENGTH) {
    return NextResponse.json(
      { error: 'Organization name must be at least 2 characters.' },
      { status: 400 },
    );
  }

  if (adminName.length < MIN_NAME_LENGTH) {
    return NextResponse.json(
      { error: 'Administrator name must be at least 2 characters.' },
      { status: 400 },
    );
  }

  if (!adminEmail) {
    return NextResponse.json({ error: 'Administrator email is required.' }, { status: 400 });
  }

  if (adminPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: 'Administrator password must be at least 8 characters.' },
      { status: 400 },
    );
  }

  return proxyPublicPost(
    '/v1/dashboard/organizations/register',
    { name, adminName, adminEmail, adminPassword },
    'Failed to register organization.',
  );
}
