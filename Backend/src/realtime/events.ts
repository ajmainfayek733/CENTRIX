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

  /**
   * Periodic proof of life, emitted on a fixed interval while connected.
   *
   * This exists because an open socket does not prove an agent is alive: a half-open TCP
   * connection survives an unplugged cable, a suspended laptop or a dropped VPN for minutes,
   * because nothing needs to be sent for the OS to keep believing in it. A heartbeat that
   * *arrives* is positive evidence at a known instant, which is what "active now" needs.
   */
  Heartbeat: 'agent:heartbeat',
} as const;

export interface AgentHelloPayload {
  agentVersion: string;
  policyVersion: number;
}

export interface AgentHeartbeatPayload {
  /**
   * Whether a user is signed in on the interactive desktop. Distinguishes "the workstation is
   * powered on and the service is running" from "someone is actually at it" — a locked machine
   * at 3am heartbeats exactly like one in use, and the dashboard should not call both active.
   */
  userPresent: boolean;
}

// ---------------------------------------------------------------------------
// Server → dashboard
// ---------------------------------------------------------------------------

export const DashboardEvent = {
  /**
   * A batch landed and has been fully aggregated.
   *
   * Carries the totals it contributed, so a dashboard can move its numbers without asking the
   * server anything. This is the aggregate the rollup table just committed — computed once, at
   * ingest, and reused rather than recomputed per viewer.
   *
   * It carries aggregates and NOT rows, and the distinction is load-bearing. A delta is safe to
   * push because applying it is unconditional arithmetic: a dashboard showing any range, any
   * filter, any employee subset can add what just arrived and be right. Rows are not, because a
   * client would have to decide whether each one belongs in its current view, deduplicate it
   * against what it already has, and reconcile after every missed event — which is how a
   * socket-fed cache drifts from the database with nothing to detect it. Log tables therefore
   * still page from the API.
   */
  TelemetryIngested: 'telemetry:ingested',

  /** An agent connected, heartbeated, or dropped. Carries the device's current liveness. */
  DevicePresence: 'device:presence',

  /**
   * Full presence table, sent once when a dashboard connects.
   *
   * Without it a freshly opened dashboard would know nothing about devices that connected before
   * it did, and would show them as offline until each happened to heartbeat — up to a full
   * interval of wrong information on the screen an operator looks at first.
   */
  PresenceSnapshot: 'device:presence-snapshot',

  /** Policy was edited, by this admin or another one. */
  PolicyUpdated: 'policy:updated',
} as const;

/**
 * What one batch added. Every field is a delta, never an absolute — see TelemetryIngested.
 *
 * Mirrors RollupDelta in modules/ingest/rollupService.ts minus its timestamps, which describe a
 * single day's span and cannot be summed into a range the way counters can.
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
  /** Days the batch touched, so a UI showing one date can ignore a backfill for another. */
  workDates: string[];
  /** Events genuinely stored — zero for a replay, which must not move anyone's numbers. */
  eventCount: number;
  /** The aggregate this batch contributed. Add it; do not replace with it. */
  delta: RollupDeltaPayload;
}

export interface DevicePresencePayload {
  /** Device row id, matching `devices.id` — not the MachineGuid. */
  deviceId: string;
  /** Whether a command sent right now would reach the agent's socket. */
  connected: boolean;
  /**
   * Whether the agent is considered live: it heartbeated within the expected interval plus a
   * grace margin. False for a device holding a socket it has gone silent on.
   */
  live: boolean;
  /** Whether a user is signed in at the workstation, as of the last heartbeat. */
  userPresent: boolean;
  /** ISO timestamp the agent was last heard from. Drives the "N seconds ago" in the UI. */
  lastSeen: string;
}

export interface PresenceSnapshotPayload {
  devices: DevicePresencePayload[];
  /**
   * How long a dashboard should wait before deciding a silent device has gone. Sent rather than
   * hardcoded in the client so an admin changing the heartbeat interval does not need a frontend
   * release for the two to stay consistent.
   */
  maxSilenceMs: number;
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
