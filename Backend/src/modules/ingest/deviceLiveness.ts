import { prisma } from '../../config/db';
import { env } from '../../config/env';

/**
 * The one place `devices.lastSeen` is written.
 *
 * Two callers keep a device's liveness current — the HTTP middleware on every authenticated
 * request, and the realtime heartbeat while an agent holds a socket. They must not each invent
 * their own staleness rule, or "online" would mean two different things depending on which path a
 * device happened to use.
 *
 * WHY IT IS THROTTLED: a fleet of 100 agents pushing six channels plus a heartbeat every couple
 * of minutes, now joined by a socket heartbeat every 30 seconds, would otherwise mean a row
 * UPDATE per signal — write amplification on the hottest table in the schema, repeatedly dirtying
 * the same row for information nobody can act on at that resolution.
 *
 * The in-memory guard is per process, which is exactly the right scope: it exists to collapse
 * writes from one server's own traffic, and a second instance collapsing its own is equally
 * correct. Worst case two instances each write once per window.
 */

/** Last write we performed, per device row id. Bounded by fleet size. */
const lastWrittenAt = new Map<string, number>();

function stalenessWindowMs(): number {
  return env.DEVICE_LAST_SEEN_MAX_STALENESS_SECONDS * 1000;
}

/**
 * Records that a device was heard from.
 *
 * @returns the timestamp now believed to be the device's last-seen, whether or not a write
 *          happened. Callers broadcast this, so a throttled call still reports something
 *          truthful rather than nothing.
 */
export async function touchDeviceLastSeen(deviceRowId: string): Promise<Date> {
  const now = new Date();
  const previous = lastWrittenAt.get(deviceRowId);

  if (previous !== undefined && now.getTime() - previous < stalenessWindowMs()) {
    return now;
  }

  lastWrittenAt.set(deviceRowId, now.getTime());

  try {
    await prisma.device.update({ where: { id: deviceRowId }, data: { lastSeen: now } });
  } catch (error) {
    // Liveness tracking must never fail the request or the connection it rides on. Clearing the
    // guard means the next signal retries rather than waiting out a window it never earned.
    lastWrittenAt.delete(deviceRowId);
    console.error(`deviceLiveness: failed to update lastSeen for ${deviceRowId}:`, error);
  }

  return now;
}

/** Drops a device's throttle state, so its next signal writes immediately. */
export function forgetDeviceLiveness(deviceRowId: string): void {
  lastWrittenAt.delete(deviceRowId);
}
