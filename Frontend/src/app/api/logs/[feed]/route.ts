import { NextResponse, type NextRequest } from 'next/server';
import { apiGet, ApiUnavailableError } from '@/lib/api-client';

/**
 * Paging proxy for the dashboard's log tables.
 *
 * The scroll windows are client components — they fetch the next page in response to a scroll,
 * which server components cannot do. They also must not hold the session token (see
 * Docs/Frontend/NextJS.md §3), so they call this same-origin handler and it attaches the
 * credential server-side.
 *
 * The feed is resolved through an explicit map rather than by interpolating the path segment
 * into a URL. A catch-all proxy would turn this route into an open door onto every API endpoint,
 * reachable by anyone who can guess a path — the allowlist is what keeps it a paging endpoint.
 */
const FEEDS = {
  activity: (params: URLSearchParams) => {
    const employeeId = params.get('employeeId');
    if (!employeeId) return null;
    return `/v1/dashboard/reports/employees/${encodeURIComponent(employeeId)}/activity`;
  },
  alerts: () => '/v1/dashboard/reports/alerts',
  usb: () => '/v1/dashboard/reports/usb-events',
  // Index only — never the image bytes, which have their own route so each view is audited
  // individually. The API restricts this to super_admin/manager; an Auditor gets a 403 here,
  // which is the same answer they get for the first page rendered on the server.
  screenshots: (params: URLSearchParams) => {
    const employeeId = params.get('employeeId');
    if (!employeeId) return null;
    return `/v1/dashboard/reports/employees/${encodeURIComponent(employeeId)}/screenshots`;
  },
} as const;

type Feed = keyof typeof FEEDS;

/** Query parameters forwarded upstream. Anything else is dropped rather than passed through. */
const FORWARDED_PARAMS = ['cursor', 'limit', 'startDate', 'endDate', 'includeResolved'] as const;

export async function GET(request: NextRequest, context: { params: Promise<{ feed: string }> }) {
  const { feed } = await context.params;

  if (!(feed in FEEDS)) {
    return NextResponse.json({ error: 'Unknown feed' }, { status: 404 });
  }

  const incoming = request.nextUrl.searchParams;
  const basePath = FEEDS[feed as Feed](incoming);

  if (!basePath) {
    return NextResponse.json({ error: 'Missing required parameter' }, { status: 400 });
  }

  const forwarded = new URLSearchParams();
  for (const name of FORWARDED_PARAMS) {
    const value = incoming.get(name);
    if (value) forwarded.set(name, value);
  }

  const query = forwarded.toString();

  try {
    const data = await apiGet<unknown>(`${basePath}${query ? `?${query}` : ''}`);
    return NextResponse.json(data);
  } catch (error) {
    // 503 for an outage so the scroll window's retry is worth taking, and its message can be
    // honest about why. A blanket 502 told the user nothing and made a restart look like a bug in
    // the page they were reading.
    if (error instanceof ApiUnavailableError) {
      console.error(`logs/${feed}: monitoring service unreachable:`, error);
      return NextResponse.json({ error: 'The monitoring service is unavailable' }, { status: 503 });
    }

    console.error(`logs/${feed}: request failed:`, error);
    return NextResponse.json({ error: 'Unable to load this page of results' }, { status: 502 });
  }
}
