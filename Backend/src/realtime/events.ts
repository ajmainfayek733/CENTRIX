/**
 * The realtime wire contract, shared by both namespaces.
 *
 * Every event name lives here rather than as a string literal at the call site: the agent (C#)
 * and the dashboard (TypeScript) both hardcode these names, so a rename is a three-repo change
 * and needs to be greppable from one place.
 *
 * SCOPE — what Socket.IO is and is not for here:
 *
 *   It is a *signalling* channel. It carries "something changed, come and get it" and nothing
 *   that matters if it is lost. Policy changes, force-sync commands and dashboard refresh hints
 *   travel this way.
 *
 *   It is NOT the telemetry path and NOT an availability oracle. Telemetry keeps going over HTTP
 *   because that path is acknowledged, retried and idempotent, and a socket that silently
 *   half-dies would lose data with no way to detect it. Availability is likewise decided by the
 *   authenticated HTTP heartbeat, never by socket state — see AVAILABILITY below.
 *
 * AVAILABILITY:
 *
 *   A connected socket proves a TCP path to *a* process existed at some point. It does not prove
 *   the database is reachable, that this server can still serve writes, or even that the peer is
 *   still there — a dropped connection can take minutes to surface as a disconnect, and a
 *   reconnecting client can look connected while every request it makes fails.
 *
 *   So: the agent gates syncing on GET /api/v1/heartbeat, and the dashboard shows a device as
 *   online from `devices.lastSeen`, which only an authenticated HTTP request updates. Socket
 *   presence is surfaced as a separate, softer signal and is never substituted for either.
 */

/** Namespace mounted for Windows agents, authenticated by device API key. */
export const AGENT_NAMESPACE = '/agents';

/** Namespace mounted for dashboard browsers, authenticated by the Better Auth session. */
export const DASHBOARD_NAMESPACE = '/dashboard';

/** Room naming. Rooms are how a message reaches one device or one tenant without a fan-out scan. */
export const room = {
  /** One agent. `deviceId` is the Device row's uuid, not the MachineGuid. */
  device: (deviceId: string) => `device:${deviceId}`,
  /** Every socket — agent or dashboard — belonging to one organization. */
  organization: (organizationId: string) => `org:${organizationId}`,
} as const;

// ---------------------------------------------------------------------------
// Server → agent
// ---------------------------------------------------------------------------

export const AgentEvent = {
  /**
   * Policy changed. Carries only the version: the agent refetches the document over HTTP so
   * there is exactly one authoritative representation of policy on the wire.
   */
  PolicyUpdated: 'policy:updated',

  /** Drain the queue now rather than waiting for the next batch interval. */
  SyncForce: 'sync:force',

  /** An admin deactivated this device. The agent stops talking to the server but keeps collecting. */
  DeviceDeactivated: 'device:deactivated',
} as const;

export interface PolicyUpdatedPayload {
  version: number;
}

export interface SyncForcePayload {
  /** Free text for the agent log, so an operator can tell a manual push from an automatic one. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Agent → server
// ---------------------------------------------------------------------------

export const AgentClientEvent = {
  /** Sent once after connecting, so the server can log what version is out there. */
  Hello: 'agent:hello',
} as const;

export interface AgentHelloPayload {
  agentVersion: string;
  policyVersion: number;
}

// ---------------------------------------------------------------------------
// Server → dashboard
// ---------------------------------------------------------------------------

export const DashboardEvent = {
  /**
   * A batch landed. This is a hint to refetch, not the data itself — sending rows here would
   * mean two sources of truth for the same table and a UI that drifts from the database.
   */
  TelemetryIngested: 'telemetry:ingested',

  /** A device's socket connected or dropped. A soft signal; `lastSeen` remains authoritative. */
  DevicePresence: 'device:presence',

  /** Policy was edited, by this admin or another one. */
  PolicyUpdated: 'policy:updated',
} as const;

export interface TelemetryIngestedPayload {
  deviceId: string;
  employeeId: string;
  channel: string;
  /** YYYY-MM-DD the batch was attributed to, so a UI showing one day can ignore other days. */
  workDate: string | null;
  eventCount: number;
}

export interface DevicePresencePayload {
  deviceId: string;
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Dashboard → server
// ---------------------------------------------------------------------------

export const DashboardClientEvent = {
  /** Ask one device to sync immediately. Admin-only; see the handler's role check. */
  ForceSync: 'device:force-sync',
} as const;

export interface ForceSyncRequest {
  deviceId: string;
}

/** Acknowledgement shape for dashboard→server calls, so the UI can report failure honestly. */
export interface CommandAck {
  ok: boolean;
  error?: string;
}
