/**
 * Realtime wire contract, mirroring Backend/src/realtime/events.ts.
 *
 * A change on either side is a two-repo commit. These are duplicated rather than shared because
 * the two tiers have no build-time link — but they are constants in both, so a rename is
 * greppable rather than hidden in string literals scattered through components.
 */

export const DASHBOARD_NAMESPACE = '/dashboard';

export const DashboardEvent = {
  /** A telemetry batch landed. A hint to refetch — never the data itself. */
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

export interface TelemetryIngestedPayload {
  deviceId: string;
  employeeId: string;
  channel: string;
  workDate: string | null;
  eventCount: number;
}

export interface DevicePresencePayload {
  /** Device row id, matching `devices.id` — not the MachineGuid. */
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
