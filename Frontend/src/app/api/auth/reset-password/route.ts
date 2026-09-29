import { NextResponse } from 'next/server';

const API_URL = process.env.MONITORING_API_URL || 'http://127.0.0.1:4000';

export async function POST(request: Request) {
  let body: { email?: string; token?: string; newPassword?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request payload' }, { status: 400 });
  }

  if (!body.email || !body.token || !body.newPassword) {
    return NextResponse.json(
      { error: 'Email, recovery token, and new password are required.' },
      { status: 400 }
    );
  }

  if (body.newPassword.length < 8) {
    return NextResponse.json(
      { error: 'New password must be at least 8 characters long.' },
      { status: 400 }
    );
  }

  try {
    const upstream = await fetch(`${API_URL}/v1/dashboard/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return NextResponse.json(
        { error: data.error || data.message || 'Failed to reset password.' },
        { status: upstream.status }
      );
    }

    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    console.error('reset-password: upstream unreachable:', error);
    return NextResponse.json(
      { error: 'The backend service is currently unreachable. Please try again shortly.' },
      { status: 503 }
    );
  }
}
