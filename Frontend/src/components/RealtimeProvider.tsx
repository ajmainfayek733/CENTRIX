'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import {
  DASHBOARD_NAMESPACE,
  DashboardEvent,
  REALTIME_URL,
  type DevicePresencePayload,
  type PresenceSnapshotPayload,
} from '@/lib/realtime';

/**
 * Holds the dashboard's realtime connection and refreshes server components when data changes.
 *
 * HOW THE SCREEN UPDATES: the socket never carries rows. It carries "something landed", and this
 * calls router.refresh(), which re-runs the server components for the current route and streams
 * the new HTML in without a navigation or a full reload. That keeps exactly one source of truth —
 * the database, read through the API — instead of a socket-fed client cache that drifts from it
 * and has to be reconciled.
 *
 * REFRESHES ARE COALESCED. A hundred agents on a two-minute cycle produce a steady trickle of
 * events, and refreshing per event would put the dashboard into a permanent refetch loop that
 * costs more than the polling it replaced. One refresh per window, however many events arrive.
 */

/** Longest a viewer waits to see new data, and the shortest gap between two refetches. */
const REFRESH_COALESCE_MS = 3_000;

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

  // Held in a ref, not state: changing it must not re-render, and the cleanup below has to be
  // able to clear a timer scheduled by an event that has already been handled.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // `cancelled` guards every async continuation. Without it, a provider unmounted during the
    // ticket fetch would still open a socket, and nothing would ever close it — the classic
    // leak in this shape of effect.
    let cancelled = false;
    let socket: Socket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_MIN_MS;

    const scheduleRefresh = () => {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        router.refresh();
      }, REFRESH_COALESCE_MS);
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
        scheduleRefresh();
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

      socket.on(DashboardEvent.TelemetryIngested, scheduleRefresh);
      socket.on(DashboardEvent.PolicyUpdated, scheduleRefresh);

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
    () => ({ connected, devices, maxSilenceMs }),
    [connected, devices, maxSilenceMs]
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
