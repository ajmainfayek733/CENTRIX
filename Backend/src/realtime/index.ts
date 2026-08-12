import type { Server as HttpServer } from 'http';
import { Server, type Namespace, type Socket } from 'socket.io';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../config/auth';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { hashDeviceApiKey } from '../utils/token';
import { currentOrganizationId } from '../config/tenant';
import { touchDeviceLastSeen } from '../modules/ingest/deviceLiveness';
import { devicePresence } from './presence';
import { verifyRealtimeTicket } from './ticket';
import {
  AGENT_NAMESPACE,
  AgentClientEvent,
  AgentEvent,
  DASHBOARD_NAMESPACE,
  DashboardClientEvent,
  DashboardEvent,
  room,
  type AgentHeartbeatPayload,
  type AgentHelloPayload,
  type CommandAck,
  type DevicePresencePayload,
  type ForceSyncRequest,
  type PolicyUpdatedPayload,
  type PresenceSnapshotPayload,
  type SyncForcePayload,
  type TelemetryIngestedPayload,
} from './events';

/**
 * Socket.IO server: two authenticated namespaces, one for agents and one for dashboards.
 *
 * Read events.ts first - it documents why this carries signalling only, and why neither side
 * treats a live socket as proof that the backend is available.
 *
 * Single-process by design. At 30-100 devices one Node process holds every connection
 * comfortably, so there is no Redis adapter here. Running more than one instance would need one;
 * that is a deployment change, and the emit helpers below are the only places that would care.
 */

/** Role that may command a device. Managers read; only an admin pushes buttons at a workstation. */
const FORCE_SYNC_ROLE = 'super_admin';

/**
 * Handshake auth field carrying the agent's device API key. Named rather than reusing
 * `Authorization`, because Socket.IO's handshake auth is a payload, not a header set.
 */
const AGENT_AUTH_FIELD = 'apiKey';

/** Handshake auth field carrying a Better Auth session token. Server-to-server clients only. */
const DASHBOARD_AUTH_FIELD = 'token';

/** Handshake auth field carrying a short-lived realtime ticket. The browser's path. */
const DASHBOARD_TICKET_FIELD = 'ticket';

interface AgentSocketData {
  deviceRowId: string;
  organizationId: string;
  deviceId: string;
  deviceName: string;
}

interface DashboardSocketData {
  userId: string;
  role: string;
  organizationId: string;
}

/**
 * Module-level handle so services can emit without threading the server through every call.
 * Null until init, and every emit helper tolerates that: the HTTP paths must keep working with
 * realtime switched off or not yet started, since they are the system of record.
 */
let io: Server | null = null;

export function initRealtime(httpServer: HttpServer): Server {
  if (io) return io;

  io = new Server(httpServer, {
    // Same origin policy as the REST API. Agents are not browsers and send no Origin header,
    // so this constrains the dashboard only.
    cors: { origin: [env.FRONTEND_URL], credentials: true },
    // Agents sit behind office proxies that often mishandle websocket upgrades; allowing the
    // polling fallback means a signalling channel still forms instead of failing closed.
    transports: ['websocket', 'polling'],
  });

  registerAgentNamespace(io.of(AGENT_NAMESPACE));
  registerDashboardNamespace(io.of(DASHBOARD_NAMESPACE));

  return io;
}

/** Releases every connection. Exported for tests and graceful shutdown. */
export async function closeRealtime(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}

// ---------------------------------------------------------------------------
// Agent namespace
// ---------------------------------------------------------------------------

function registerAgentNamespace(namespace: Namespace) {
  namespace.use(async (socket, next) => {
    try {
      const apiKey = socket.handshake.auth?.[AGENT_AUTH_FIELD];

      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        return next(new Error('Missing device API key'));
      }

      // Same single indexed lookup on an HMAC as deviceAuth; the credential is never compared
      // in application code, so this is constant-time with respect to the presented key.
      const device = await prisma.device.findUnique({
        where: { apiKeyHash: hashDeviceApiKey(apiKey) },
        select: { id: true, organizationId: true, deviceId: true, deviceName: true, isActive: true },
      });

      if (!device) return next(new Error('Invalid device credential'));
      if (!device.isActive) return next(new Error('Device has been deactivated'));

      const data: AgentSocketData = {
        deviceRowId: device.id,
        organizationId: device.organizationId,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      };
      socket.data = data;

      next();
    } catch (error) {
      // Never leak the reason to an unauthenticated peer; the detail goes to the server log.
      console.error('realtime: agent handshake failed:', error);
      next(new Error('Authentication failed'));
    }
  });

  namespace.on('connection', (socket: Socket) => {
    const { deviceRowId, organizationId, deviceName } = socket.data as AgentSocketData;

    socket.join(room.device(deviceRowId));
    socket.join(room.organization(organizationId));

    // Tracks whether a user is at the workstation, from the most recent heartbeat. Held on the
    // socket rather than in the registry because it is agent-reported state, not presence.
    let userPresent = false;

    if (devicePresence.add(deviceRowId, socket.id, organizationId)) {
      void announcePresence(organizationId, deviceRowId, { connected: true, userPresent });
    }

    socket.on(AgentClientEvent.Hello, (payload: AgentHelloPayload) => {
      console.log(
        `realtime: agent ${deviceName} connected (agent v${payload?.agentVersion ?? '?'}, ` +
          `policy v${payload?.policyVersion ?? '?'})`
      );
    });

    // Proof of life. This is what makes "active now" trustworthy - see presence.ts for why a
    // connection alone is not enough. It also writes lastSeen through the same throttled path the
    // HTTP middleware uses, so a workstation that is connected but not currently syncing still
    // reads as recently seen instead of decaying to "offline" between batches.
    socket.on(AgentClientEvent.Heartbeat, (payload: AgentHeartbeatPayload) => {
      userPresent = payload?.userPresent ?? false;
      devicePresence.heartbeat(deviceRowId);
      void announcePresence(organizationId, deviceRowId, { connected: true, userPresent });
    });

    socket.on('disconnect', (reason) => {
      // Presence is per-device, not per-socket: a reconnect that races its own disconnect must
      // not report the device as gone, which is why this only fires on the last socket.
      if (devicePresence.remove(deviceRowId, socket.id)) {
        void announcePresence(organizationId, deviceRowId, { connected: false, userPresent: false });
      }
      console.log(`realtime: agent ${deviceName} disconnected (${reason})`);
    });
  });
}

/**
 * Records that a device was heard from and tells the dashboards.
 *
 * The lastSeen write is throttled inside touchDeviceLastSeen, but the broadcast is not: the
 * dashboard should tick on every heartbeat even when the database write was collapsed, because
 * the point of this path is that the screen is current. A broadcast is a few bytes to sockets
 * already open; a row update is not.
 */
async function announcePresence(
  organizationId: string,
  deviceRowId: string,
  state: { connected: boolean; userPresent: boolean }
): Promise<void> {
  try {
    const maxSilenceMs = await maxSilenceForOrganization(organizationId);
    const lastSeen = state.connected ? await touchDeviceLastSeen(deviceRowId) : new Date();

    broadcastPresence(organizationId, {
      deviceId: deviceRowId,
      connected: state.connected,
      live: state.connected && devicePresence.isLive(deviceRowId, maxSilenceMs),
      userPresent: state.userPresent,
      lastSeen: lastSeen.toISOString(),
    });
  } catch (error) {
    console.error('realtime: failed to announce presence:', error);
  }
}

/**
 * How long a device may stay silent before it stops counting as live.
 *
 * The configured heartbeat interval plus a grace multiplier: a single dropped or delayed frame -
 * a garbage-collection pause, a busy uplink - must not flip a healthy workstation to offline and
 * back. Two missed beats is the threshold.
 */
const HEARTBEAT_GRACE_MULTIPLIER = 2.5;

async function maxSilenceForOrganization(organizationId: string): Promise<number> {
  const policy = await prisma.policy.findUnique({
    where: { organizationId },
    select: { presenceHeartbeatSeconds: true },
  });

  const seconds = policy?.presenceHeartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  return seconds * HEARTBEAT_GRACE_MULTIPLIER * 1000;
}

/** Fallback when an organization has no policy row. Matches the schema default. */
const DEFAULT_HEARTBEAT_SECONDS = 30;

// ---------------------------------------------------------------------------
// Dashboard namespace
// ---------------------------------------------------------------------------

function registerDashboardNamespace(namespace: Namespace) {
  namespace.use(async (socket, next) => {
    try {
      // Two accepted credentials, in order of preference:
      //
      //   ticket - the normal browser path. The dashboard's session lives in an httpOnly cookie
      //            the page cannot read, so its Next.js server exchanges the cookie for a
      //            short-lived, socket-only ticket and the browser holds only that. See ticket.ts
      //            for why handing the session token to JavaScript was not an option.
      //
      //   token  - a bearer session token, for server-to-server clients and tests that already
      //            hold one legitimately. Never used by the browser.
      const claims = verifyRealtimeTicket(socket.handshake.auth?.[DASHBOARD_TICKET_FIELD]);

      let userId: string;
      let role: string;

      if (claims) {
        ({ userId, role } = claims);
      } else {
        const token = socket.handshake.auth?.[DASHBOARD_AUTH_FIELD];
        const headers = fromNodeHeaders({
          ...socket.handshake.headers,
          ...(typeof token === 'string' && token.length > 0
            ? { authorization: `Bearer ${token}` }
            : {}),
        });

        const session = await auth.api.getSession({ headers });

        if (!session?.user) return next(new Error('Unauthorized'));
        if ((session.user as { isActive?: boolean }).isActive === false) {
          return next(new Error('Account deactivated'));
        }

        userId = session.user.id;
        role = (session.user as { role?: string }).role ?? 'manager';
      }

      // Dashboard users are not tenant-scoped in the schema yet; the deployment is single-org,
      // so the room is resolved from the only organization rather than invented per user.
      const organizationId = await currentOrganizationId();

      const data: DashboardSocketData = { userId, role, organizationId };
      socket.data = data;

      next();
    } catch (error) {
      console.error('realtime: dashboard handshake failed:', error);
      next(new Error('Authentication failed'));
    }
  });

  namespace.on('connection', (socket: Socket) => {
    const { organizationId, role } = socket.data as DashboardSocketData;

    socket.join(room.organization(organizationId));

    // Seed this dashboard with the current presence table. Devices that connected before this
    // browser did will not heartbeat again for up to a full interval, and until then the screen
    // an operator looks at first would show them all as offline.
    void (async () => {
      try {
        const maxSilenceMs = await maxSilenceForOrganization(organizationId);
        const payload: PresenceSnapshotPayload = {
          devices: devicePresence.snapshot(organizationId, maxSilenceMs).map((entry) => ({
            deviceId: entry.deviceId,
            connected: true,
            live: entry.live,
            // Not tracked per device across reconnects; the next heartbeat corrects it within
            // one interval. Claiming a user is present on no evidence would be worse.
            userPresent: false,
            lastSeen: entry.lastHeartbeatAt,
          })),
          maxSilenceMs,
        };
        socket.emit(DashboardEvent.PresenceSnapshot, payload);
      } catch (error) {
        console.error('realtime: failed to send presence snapshot:', error);
      }
    })();

    socket.on(
      DashboardClientEvent.ForceSync,
      (request: ForceSyncRequest, ack?: (result: CommandAck) => void) => {
        if (role !== FORCE_SYNC_ROLE) {
          ack?.({ ok: false, error: 'Only an administrator can force a device to sync' });
          return;
        }

        if (!request?.deviceId) {
          ack?.({ ok: false, error: 'deviceId is required' });
          return;
        }

        // Reported honestly: if the agent holds no socket the command cannot be delivered now,
        // and the UI must say so rather than showing a success it cannot vouch for. The device
        // will still sync on its own interval.
        if (!devicePresence.isConnected(request.deviceId)) {
          ack?.({ ok: false, error: 'Device is not currently connected; it will sync on its next interval' });
          return;
        }

        requestDeviceSync(request.deviceId, `dashboard request by user ${socket.data.userId}`);
        ack?.({ ok: true });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Emit helpers - the only supported way for the rest of the server to publish.
//
// All of them are no-ops before init and are wrapped so a realtime failure can never fail the
// HTTP request that triggered it. Signalling is best-effort by design; the data is already
// committed by the time these run.
// ---------------------------------------------------------------------------

function safeEmit(action: () => void) {
  if (!io) return;
  try {
    action();
  } catch (error) {
    console.error('realtime: emit failed:', error);
  }
}

/** Tell every agent in an org that policy moved, and tell the dashboards so their UI updates. */
export function broadcastPolicyUpdated(organizationId: string, version: number) {
  const payload: PolicyUpdatedPayload = { version };

  safeEmit(() => {
    io!.of(AGENT_NAMESPACE).to(room.organization(organizationId)).emit(AgentEvent.PolicyUpdated, payload);
    io!.of(DASHBOARD_NAMESPACE).to(room.organization(organizationId)).emit(DashboardEvent.PolicyUpdated, payload);
  });
}

/** Ask one agent to drain its queue now. */
export function requestDeviceSync(deviceRowId: string, reason: string) {
  const payload: SyncForcePayload = { reason };
  safeEmit(() => {
    io!.of(AGENT_NAMESPACE).to(room.device(deviceRowId)).emit(AgentEvent.SyncForce, payload);
  });
}

/** Tell an agent it has been switched off, so it stops pushing without waiting for a 403. */
export function notifyDeviceDeactivated(deviceRowId: string) {
  safeEmit(() => {
    io!.of(AGENT_NAMESPACE).to(room.device(deviceRowId)).emit(AgentEvent.DeviceDeactivated, {});
  });
}

/** Hint to dashboards that a batch landed, so they refetch the affected view. */
export function broadcastTelemetryIngested(organizationId: string, payload: TelemetryIngestedPayload) {
  safeEmit(() => {
    io!.of(DASHBOARD_NAMESPACE).to(room.organization(organizationId)).emit(DashboardEvent.TelemetryIngested, payload);
  });
}

function broadcastPresence(organizationId: string, payload: DevicePresencePayload) {
  safeEmit(() => {
    io!.of(DASHBOARD_NAMESPACE).to(room.organization(organizationId)).emit(DashboardEvent.DevicePresence, payload);
  });
}

export { devicePresence };
