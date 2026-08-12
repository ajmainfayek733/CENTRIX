/**
 * How a screenshot is addressed in the browser.
 *
 * One place, imported by both the tag that renders an image and the route that serves it, so the
 * two cannot drift into disagreeing about the URL shape.
 */

/** Only JPEG is stored - see the agent's capture pipeline and the backend's screenshotStorage. */
export const SCREENSHOT_IMAGE_EXTENSION = '.jpg';

/**
 * Same-origin URL for one capture.
 *
 * Points at the Next proxy rather than the API: the session lives in an httpOnly cookie that an
 * `<img>` cannot send, so the credential is attached server-side by that route.
 */
export function screenshotImageUrl(capture: { deviceId: string; clientEventId: string }): string {
  return `/api/screenshots/${encodeURIComponent(capture.deviceId)}/${encodeURIComponent(
    capture.clientEventId
  )}${SCREENSHOT_IMAGE_EXTENSION}`;
}
