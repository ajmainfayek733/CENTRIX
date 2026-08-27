/**
 * Realtime wire contract, mirroring Backend/src/realtime/events.ts.
 *
 * A change on either side is a two-repo commit. These are duplicated rather than shared because
 * the two tiers have no build-time link - but they are constants in both, so a rename is
 * greppable rather than hidden in string literals scattered through components.
 */

export const DASHBOARD_NAMESPACE = '/dashboard';

export const DashboardEvent = {
  /** A telemetry batch landed. A hint to refetch - never the data itself. */
  TelemetryIngested: 'telemetry:ingested',
  /** An agent connected, heartbeated, or dropped. Carries the device's current liveness. */
  DevicePresence: 'device:presence',
  /** The full presence table, sent once on connect so a fresh tab is not blind. */
  PresenceSnapshot: 'device:presence-snapshot',
  /** Policy was edited, possibly by another admin. */
  PolicyUpdated: 'policy:updated',
} as const;

export const DashboardClientEvent = {
  ForceSync: 'device:force-sync',
} as const;

/**
 * What one ingested batch added. Every field is a delta, never an absolute.
 *
 * Deltas are what makes this safe to apply blind: a screen showing any date range, filter or
 * employee subset can add what just arrived and still be correct. An absolute value for one
 * (day, device, employee) could not be folded into a range total without knowing what that key
 * already contributed.
 */
export interface RollupDeltaPayload {
  activeSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  blacklistedSeconds: number;
  keyCount: number;
  mouseCount: number;
  activitySessionCount: number;
  browserVisitCount: number;
  usbEventCount: number;
  alertCount: number;
}

export interface TelemetryIngestedPayload {
  deviceId: string;
  employeeId: string;
  channel: string;
  /** Days the batch touched, so a screen showing one date can ignore a backfill for another. */
  workDates: string[];
  /** Events genuinely stored - zero for a replay, which must not move anyone's numbers. */
  eventCount: number;
  delta: RollupDeltaPayload;
}

export function emptyRollupDelta(): RollupDeltaPayload {
  return {
    activeSeconds: 0,
    idleSeconds: 0,
    productiveSeconds: 0,
    unproductiveSeconds: 0,
    neutralSeconds: 0,
    blacklistedSeconds: 0,
    keyCount: 0,
    mouseCount: 0,
    activitySessionCount: 0,
    browserVisitCount: 0,
    usbEventCount: 0,
    alertCount: 0,
  };
}

export function addRollupDelta(
  base: RollupDeltaPayload,
  addend: RollupDeltaPayload
): RollupDeltaPayload {
  return {
    activeSeconds: base.activeSeconds + addend.activeSeconds,
    idleSeconds: base.idleSeconds + addend.idleSeconds,
    productiveSeconds: base.productiveSeconds + addend.productiveSeconds,
    unproductiveSeconds: base.unproductiveSeconds + addend.unproductiveSeconds,
    neutralSeconds: base.neutralSeconds + addend.neutralSeconds,
    blacklistedSeconds: base.blacklistedSeconds + addend.blacklistedSeconds,
    keyCount: base.keyCount + addend.keyCount,
    mouseCount: base.mouseCount + addend.mouseCount,
    activitySessionCount: base.activitySessionCount + addend.activitySessionCount,
    browserVisitCount: base.browserVisitCount + addend.browserVisitCount,
    usbEventCount: base.usbEventCount + addend.usbEventCount,
    alertCount: base.alertCount + addend.alertCount,
  };
}

export interface DevicePresencePayload {
  /** Device row id, matching `devices.id` - not the MachineGuid. */
  deviceId: string;
  /** Whether a command sent right now would reach the agent's socket. */
  connected: boolean;
  /** Whether the agent heartbeated recently enough to count as live. */
  live: boolean;
  /** Whether a user is signed in at the workstation, as of the last heartbeat. */
  userPresent: boolean;
  /** ISO timestamp the agent was last heard from. */
  lastSeen: string;
}

export interface PresenceSnapshotPayload {
  devices: DevicePresencePayload[];
  /**
   * How long to wait before treating a silent device as gone. Supplied by the server rather than
   * hardcoded here, so changing the heartbeat interval in admin config does not need a frontend
   * release for the two to stay consistent.
   */
  maxSilenceMs: number;
}

export interface CommandAck {
  ok: boolean;
  error?: string;
}

/**
 * Where the browser opens its socket.
 *
 * Separate from MONITORING_API_URL because that one is server-only: it can be an internal
 * hostname the browser cannot resolve. This must be the address a browser can reach.
 */
export const REALTIME_URL =
  process.env.NEXT_PUBLIC_MONITORING_API_URL ?? 'http://localhost:5000';
