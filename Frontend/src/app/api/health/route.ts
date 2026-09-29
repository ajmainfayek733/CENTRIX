import { NextResponse } from 'next/server';

/**
 * Liveness probe for the container orchestrator (docker compose healthcheck, ALB target group).
 *
 * Deliberately does not call the monitoring API. The dashboard process being up is a separate
 * fact from the API being up, and coupling them would make an API outage restart a perfectly
 * healthy frontend container in a loop. API availability is probed at the API's own /health.
 *
 * Excluded from the route gate in proxy.ts by its `api` matcher exclusion, so it needs no session.
 */
export function GET(): NextResponse {
  return NextResponse.json(
    { status: 'ok', timestamp: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
