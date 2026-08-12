import { ActivityType } from '@prisma/client';

/**
 * What counts as time at the keyboard.
 *
 * Shared by the ingest-time rollup and the read path on purpose. When these two disagree the
 * symptom is a dashboard whose totals drift from its own aggregate table, with nothing failing
 * loudly - so there is exactly one definition and both sides import it.
 */

/** Foreground work. Everything else is time the employee was not at the keyboard. */
export const ACTIVE_TYPES: readonly ActivityType[] = [ActivityType.Application, ActivityType.Desktop];

export const IDLE_TYPES: readonly ActivityType[] = [
  ActivityType.Idle,
  ActivityType.Locked,
  ActivityType.Sleeping,
  ActivityType.Disconnected,
];

export function isActiveType(type: ActivityType): boolean {
  return ACTIVE_TYPES.includes(type);
}

export function isIdleType(type: ActivityType): boolean {
  return IDLE_TYPES.includes(type);
}
