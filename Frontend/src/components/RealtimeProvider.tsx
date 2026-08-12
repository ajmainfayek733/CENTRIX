'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import {
  DASHBOARD_NAMESPACE,
  DashboardEvent,
  REALTIME_URL,
  type DevicePresencePayload,
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

interface RealtimeContextValue {
  /** Whether the signalling socket is currently open. Presentational only — see below. */
  connected: boolean;
  /**
   * Device ids currently holding an agent socket.
   *
   * NOT an online indicator. A device is shown as online from `lastSeen`, which only an
   * authenticated HTTP request updates. This says something narrower: whether a force-sync sent
   * right now would be delivered immediately.
   */
  connectedDevices: ReadonlySet<string>;
}

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  connectedDevices: new Set(),
});

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState<ReadonlySet<string>>(new Set());

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
        setConnectedDevices(new Set());
        retry();
      });

      socket.on('connect_error', () => {
        if (cancelled) return;
        setConnected(false);
        retry();
      });

      socket.on(DashboardEvent.TelemetryIngested, scheduleRefresh);
      socket.on(DashboardEvent.PolicyUpdated, scheduleRefresh);

      socket.on(DashboardEvent.DevicePresence, (payload: DevicePresencePayload) => {
        if (cancelled) return;
        setConnectedDevices((current) => {
          const next = new Set(current);
          if (payload.connected) next.add(payload.deviceId);
          else next.delete(payload.deviceId);
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

  const value = useMemo(() => ({ connected, connectedDevices }), [connected, connectedDevices]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
