import { NextResponse } from 'next/server';

const API_URL = process.env.MONITORING_API_URL || 'http://127.0.0.1:4000';

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
    return NextResponse.json({ error: 'Malformed JSON payload' }, { status: 400 });
  }

  if (!body.name || body.name.trim().length < 2) {
    return NextResponse.json(
      { error: 'Organization name must be at least 2 characters.' },
      { status: 400 }
    );
  }

  try {
    const upstream = await fetch(`${API_URL}/v1/dashboard/organizations/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return NextResponse.json(
        { error: data.error || data.message || 'Failed to register organization.' },
        { status: upstream.status }
      );
    }

    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    console.error('register-organization: upstream unreachable:', error);
    return NextResponse.json(
      { error: 'The backend service is currently unreachable. Please try again shortly.' },
      { status: 503 }
    );
  }
}
