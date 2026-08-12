import { NextResponse, type NextRequest } from 'next/server';
import { serverFetch, ApiUnavailableError } from '@/lib/api-client';
import { SCREENSHOT_IMAGE_EXTENSION } from '@/lib/screenshots';

/**
 * Image proxy for the screenshot gallery.
 *
 * WHY THIS EXISTS AT ALL: the API serves screenshots only to an authenticated caller, and the
 * session token is in an httpOnly cookie by design (Docs/Frontend/NextJS.md §3). A browser
 * `<img src>` cannot carry an Authorization header, and the alternatives are both worse — putting
 * the token somewhere JavaScript can read it, or making the image endpoint public and protecting
 * it with an unguessable path, which is not protection at all for the most invasive data in the
 * product. So the tag points at this same-origin route and the credential is attached server-side.
 *
 * The upstream request is what the backend audit-logs (spec §3, "every access is logged"), so
 * viewing an image still produces an audit entry naming the viewer, the device and the capture.
 */

/**
 * Path segments are validated rather than trusted.
 *
 * Both are opaque identifiers issued by the backend, so a strict charset costs nothing and keeps
 * this from becoming a way to address arbitrary upstream paths — `..%2F..%2Fadmin` is a URL
 * segment like any other once it is interpolated. Length is bounded for the same reason.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** Sent when the API omits a content type, which it should never do for a stored capture. */
const DEFAULT_IMAGE_TYPE = 'image/jpeg';

/**
 * How long the browser may reuse an image without asking again.
 *
 * `private` because these are pictures of an employee's desktop and must never land in a shared
 * or CDN cache. A short lifetime is still worth having: the viewer re-mounts the same image while
 * zooming, panning and stepping back and forth through the gallery, and re-fetching each time
 * would re-download the full-size capture — and file an audit entry — for a screen the operator
 * is already looking at. The entry recording that they opened it has already been written.
 */
const CACHE_SECONDS = 300;

/** Upstream statuses that mean the service could not answer, as opposed to a refusal. */
const SERVER_ERROR_THRESHOLD = 500;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ deviceId: string; file: string }> }
) {
  const { deviceId, file } = await context.params;

  if (!file.endsWith(SCREENSHOT_IMAGE_EXTENSION)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const clientEventId = file.slice(0, -SCREENSHOT_IMAGE_EXTENSION.length);

  if (!SAFE_SEGMENT.test(deviceId) || !SAFE_SEGMENT.test(clientEventId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const upstream = await serverFetch(
      `/v1/dashboard/reports/screenshots/${encodeURIComponent(deviceId)}/${encodeURIComponent(clientEventId)}${SCREENSHOT_IMAGE_EXTENSION}`
    );

    if (!upstream.ok) {
      if (upstream.status >= SERVER_ERROR_THRESHOLD) {
        console.error(`screenshots: monitoring service returned ${upstream.status}`);
        return NextResponse.json({ error: 'The monitoring service is unavailable' }, { status: 503 });
      }

      // 401/403 (session gone, or an Auditor — screenshots are excluded from that role by spec
      // §6) and 404 are passed through unchanged: they are answers, not failures, and the gallery
      // shows a broken tile rather than pretending the image is still loading.
      return NextResponse.json({ error: 'Screenshot unavailable' }, { status: upstream.status });
    }

    // Streamed rather than buffered — a full-resolution capture has no business being held in
    // memory here on its way from one socket to another.
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? DEFAULT_IMAGE_TYPE,
        'cache-control': `private, max-age=${CACHE_SECONDS}`,
        // The bytes for a given capture never change, so a revalidation can be answered from the
        // cache once the max-age lapses instead of re-sending the image.
        ...(upstream.headers.get('etag') ? { etag: upstream.headers.get('etag') as string } : {}),
        ...(upstream.headers.get('content-length')
          ? { 'content-length': upstream.headers.get('content-length') as string }
          : {}),
      },
    });
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      console.error('screenshots: monitoring service unreachable:', error);
      return NextResponse.json({ error: 'The monitoring service is unavailable' }, { status: 503 });
    }

    console.error('screenshots: request failed:', error);
    return NextResponse.json({ error: 'Unable to load this screenshot' }, { status: 502 });
  }
}
