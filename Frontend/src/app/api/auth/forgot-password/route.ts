import { NextResponse } from 'next/server';

const API_URL = process.env.MONITORING_API_URL || 'http://127.0.0.1:4000';

export async function POST(request: Request) {
  let body: { email?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request payload' }, { status: 400 });
  }

  if (!body.email) {
    return NextResponse.json({ error: 'Email address is required.' }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${API_URL}/v1/dashboard/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: body.email }),
      cache: 'no-store',
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return NextResponse.json(
        { error: data.error || data.message || 'Failed to process password recovery request.' },
        { status: upstream.status }
      );
    }

    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    console.error('forgot-password: upstream unreachable:', error);
    return NextResponse.json(
      { error: 'The backend service is currently unreachable. Please try again shortly.' },
      { status: 503 }
    );
  }
}
