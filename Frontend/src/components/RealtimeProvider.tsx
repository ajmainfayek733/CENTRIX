'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import {
  DASHBOARD_NAMESPACE,
  DashboardEvent,
  REALTIME_URL,
  addRollupDelta,
  emptyRollupDelta,
  type DevicePresencePayload,
  type PresenceSnapshotPayload,
  type RollupDeltaPayload,
  type TelemetryIngestedPayload,
} from '@/lib/realtime';

/**
 * Holds the dashboard's realtime connection and refreshes server components when data changes.
 *
 * TWO KINDS OF UPDATE, AND ONLY ONE OF THEM IS RATE-LIMITED:
 *
 *   Presence (device liveness, "Active now", the online count) is applied to React state the
 *   instant an event arrives. Nothing is deferred, nothing is polled. This is the part that has
 *   to feel live, and it does.
 *
 *   Server-rendered report data (overview totals, rosters, log tables) is refreshed by calling
 *   router.refresh(), which re-runs the server components for the current route and streams new
 *   HTML in without a navigation or a reload. The socket deliberately does not carry these rows:
 *   a socket-fed client cache drifts from the database and has to be reconciled after every
 *   missed event, reconnect and permission change. Re-reading from the API keeps one source of
 *   truth.
 *
 * THE RATE LIMIT IS A DEBOUNCE, NOT A SCHEDULE. Nothing here runs on a timer when nothing is
 * happening — a refresh is only ever triggered by an event. What the limit does is cap how often
 * events may cause a refetch: a hundred agents on a two-minute cycle produce clustered bursts of
 * `telemetry:ingested`, and refreshing per event would mean several full server-component renders
 * per second, which costs more than the polling this replaced.
 *
 * It fires on the LEADING edge. The first event refreshes immediately and only a burst behind it
 * is collapsed into one trailing refresh. A trailing-only debounce would have delayed every update
 * by the full window — including a lone event on a quiet system, which is the case where the
 * dashboard most obviously ought to feel instant.
 */

/**
 * Minimum gap between two refetches.
 *
 * Not a delay: the first event after a quiet period refreshes with no wait at all. This only
 * bounds how closely two refreshes may follow each other.
 *
 * Comfortably longer than it would need to be if refetching were how the numbers updated. It is
 * not — totals move from the aggregate pushed with each event. This exists for what a delta
 * cannot express: a new row appearing in a log table, a device changing hands, an employee being
 * added. Those tolerate a few seconds; the figures do not, and no longer wait.
 */
const REFRESH_MIN_INTERVAL_MS = 15_000;

/** How long to wait before rebuilding a dropped connection, and the ceiling on that backoff. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * What the dashboard knows about one workstation right now.
 *
 * `live` is the answer to "is this device active", and it is derived from a heartbeat having
 * arrived — not from a socket existing. A half-open connection outlives an unplugged cable or a
 * suspended laptop by minutes, so connection state alone would keep a dead machine green.
 */
export interface DeviceLiveness {
  connected: boolean;
  live: boolean;
  userPresent: boolean;
  lastSeen: string;
}

interface RealtimeContextValue {
  /** Whether this browser's own signalling socket is open. */
  connected: boolean;
  /** Live state per device row id, as of the most recent heartbeat from each. */
  devices: ReadonlyMap<string, DeviceLiveness>;
  /** How long a device may stay silent before this client stops calling it live. */
  maxSilenceMs: number;
  /**
   * Everything ingested since this page was server-rendered, summed across the whole fleet.
   *
   * Added to a server-rendered figure to get the current one. Reset on every refetch, because at
   * that moment the server-rendered baseline already includes it — not resetting is how the same
   * telemetry would end up counted twice.
   */
  liveDelta: RollupDeltaPayload;
  /** The same, per employee, for tables with a row each. */
  liveDeltaByEmployee: ReadonlyMap<string, RollupDeltaPayload>;
}

/**
 * Fallback until the server's snapshot arrives — the schema's 30s heartbeat with the same 2.5x
 * grace the server applies. Only used for the fraction of a second before the socket is up.
 */
const DEFAULT_MAX_SILENCE_MS = 30_000 * 2.5;

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  devices: new Map(),
  maxSilenceMs: DEFAULT_MAX_SILENCE_MS,
  liveDelta: emptyRollupDelta(),
  liveDeltaByEmployee: new Map(),
});

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

/**
 * Live state for one device, or null when nothing has been heard about it.
 *
 * Expires client-side: a device whose last heartbeat is older than the silence window stops
 * counting as live even though no event said so. That matters because the event announcing a
 * departure is exactly the one that cannot arrive when a workstation vanishes — a laptop that
 * loses power sends no disconnect, so a UI waiting to be told would show it active indefinitely.
 */
export function useDeviceLiveness(deviceId: string): DeviceLiveness | null {
  const { devices, maxSilenceMs } = useRealtime();
  const now = useNow();

  const state = devices.get(deviceId);
  if (!state) return null;

  const silentFor = now - new Date(state.lastSeen).getTime();
  return { ...state, live: state.live && silentFor <= maxSilenceMs };
}

/**
 * A clock that ticks once a second, so "3s ago" counts up and liveness expires without an event.
 *
 * One interval per component that asks. These render a handful of rows, so this stays cheap; a
 * table of thousands would want a single shared ticker instead.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return now;
}

const CLOCK_TICK_MS = 1_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<ReadonlyMap<string, DeviceLiveness>>(new Map());
  const [maxSilenceMs, setMaxSilenceMs] = useState(DEFAULT_MAX_SILENCE_MS);
  const [liveDelta, setLiveDelta] = useState<RollupDeltaPayload>(emptyRollupDelta);
  const [liveDeltaByEmployee, setLiveDeltaByEmployee] = useState<ReadonlyMap<string, RollupDeltaPayload>>(
    new Map()
  );

  // Held in refs, not state: changing them must not re-render, and the cleanup below has to be
  // able to clear a timer armed by an event that has already been handled.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    // `cancelled` guards every async continuation. Without it, a provider unmounted during the
    // ticket fetch would still open a socket, and nothing would ever close it — the classic
    // leak in this shape of effect.
    let cancelled = false;
    let socket: Socket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_MIN_MS;

    const refreshNow = () => {
      lastRefreshAt.current = Date.now();
      // Cleared in the same breath as the refetch is requested. Once the server re-renders, its
      // figures already include everything these deltas represent, so keeping them would count
      // the same telemetry twice. Anything arriving between here and the new HTML lands in a
      // fresh delta and is applied on top, which is correct.
      setLiveDelta(emptyRollupDelta());
      setLiveDeltaByEmployee(new Map());
      router.refresh();
    };

    /**
     * Refetches server-rendered data, at most once per REFRESH_MIN_INTERVAL_MS.
     *
     * Leading edge: an event arriving after a quiet period refreshes immediately. Only events
     * that land inside the cooldown are collapsed, and they produce exactly one refresh when it
     * expires — so a burst costs one refetch rather than one per event, and an isolated event
     * costs no delay at all.
     */
    const requestRefresh = () => {
      if (cancelled) return;

      const sinceLast = Date.now() - lastRefreshAt.current;

      if (sinceLast >= REFRESH_MIN_INTERVAL_MS) {
        refreshNow();
        return;
      }

      // A refresh is already queued for the end of this cooldown; this event joins it.
      if (refreshTimer.current) return;

      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        if (!cancelled) refreshNow();
      }, REFRESH_MIN_INTERVAL_MS - sinceLast);
    };

    const connect = async () => {
      if (cancelled) return;

      let ticket: string;
      try {
        const response = await fetch('/api/realtime/ticket', { method: 'POST' });
        if (!response.ok) throw new Error('ticket refused');
        ({ ticket } = (await response.json()) as { ticket: string });
      } catch {
        // No ticket means no live updates — never means the page is broken. Every screen still
        // renders from its own server-side fetch; it just will not update on its own.
        retry();
        return;
      }

      if (cancelled) return;

      socket = io(`${REALTIME_URL}${DASHBOARD_NAMESPACE}`, {
        auth: { ticket },
        // Reconnection is driven here rather than by the library because a ticket expires in a
        // minute: the library would loop forever re-presenting a credential that is already
        // stale, whereas `connect()` fetches a fresh one each time.
        reconnection: false,
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', () => {
        if (cancelled) return;
        setConnected(true);
        reconnectDelay = RECONNECT_MIN_MS;
        // Data may have changed while the socket was down, and nothing will announce what was
        // missed — so treat every (re)connection as a reason to refetch once.
        requestRefresh();
      });

      socket.on('disconnect', () => {
        if (cancelled) return;
        setConnected(false);
        // Cleared rather than frozen. Holding the last known table would leave every device
        // showing as it was at the moment this browser lost touch, with nothing to correct it —
        // stale green dots are worse than an honest "not known".
        setDevices(new Map());
        retry();
      });

      socket.on('connect_error', () => {
        if (cancelled) return;
        setConnected(false);
        retry();
      });

      // The aggregate arrives with the event, so the totals on screen move immediately — no
      // request, no waiting for a refetch. The refresh below is a correctness backstop for the
      // things a delta cannot express (new rows in a log table, a device changing hands), not
      // the path that updates the numbers.
      socket.on(DashboardEvent.TelemetryIngested, (payload: TelemetryIngestedPayload) => {
        if (cancelled) return;

        // A replay stored nothing, and its delta is zero. Guarded explicitly anyway: this is the
        // one place a double-count would be invisible, and the cost of the check is nothing.
        if (payload.eventCount > 0 && payload.delta) {
          setLiveDelta((current) => addRollupDelta(current, payload.delta));
          setLiveDeltaByEmployee((current) => {
            const next = new Map(current);
            next.set(
              payload.employeeId,
              addRollupDelta(next.get(payload.employeeId) ?? emptyRollupDelta(), payload.delta)
            );
            return next;
          });
        }

        requestRefresh();
      });

      socket.on(DashboardEvent.PolicyUpdated, requestRefresh);

      socket.on(DashboardEvent.PresenceSnapshot, (payload: PresenceSnapshotPayload) => {
        if (cancelled) return;
        setMaxSilenceMs(payload.maxSilenceMs);
        setDevices(new Map(payload.devices.map((device) => [device.deviceId, device])));
      });

      socket.on(DashboardEvent.DevicePresence, (payload: DevicePresencePayload) => {
        if (cancelled) return;
        setDevices((current) => {
          const next = new Map(current);
          if (payload.connected) {
            next.set(payload.deviceId, payload);
          } else {
            // A clean disconnect is real information: the agent said goodbye. Dropping the entry
            // makes the UI fall back to the server-rendered lastSeen, which is the honest source
            // once there is no live channel to the device.
            next.delete(payload.deviceId);
          }
          return next;
        });
      });
    };

    const retry = () => {
      if (cancelled || reconnectTimer) return;

      // Exponential backoff, so a backend that is down does not get a connection attempt per
      // second from every open dashboard tab in the building.
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        socket?.close();
        socket = null;
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        void connect();
      }, reconnectDelay);
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      // removeAllListeners before close: the handlers close over setState, and firing one after
      // unmount is both a React warning and a reference the socket keeps alive.
      socket?.removeAllListeners();
      socket?.close();
    };
  }, [router]);

  const value = useMemo(
    () => ({ connected, devices, maxSilenceMs, liveDelta, liveDeltaByEmployee }),
    [connected, devices, maxSilenceMs, liveDelta, liveDeltaByEmployee]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
