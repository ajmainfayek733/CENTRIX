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
  /** An agent's signalling socket connected or dropped. Soft signal; `lastSeen` is authoritative. */
  DevicePresence: 'device:presence',
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
  deviceId: string;
  connected: boolean;
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
