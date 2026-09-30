'use client';

import { useRealtime } from '@/components/RealtimeProvider';
import { StatTile } from '@/components/ui';

/**
 * "Online now" as a number that actually moves.
 *
 * The server-rendered count is devices whose `lastSeen` falls inside a five-minute window - a
 * reasonable answer that is nonetheless up to five minutes stale, and only recomputed when the
 * page is refetched. Once the socket is up, the live presence table is strictly better: it is one
 * heartbeat old, and it drops a device the moment it goes quiet.
 *
 * `fallback` is what renders before the socket connects and whenever it is down. It is used
 * rather than showing zero, because "no live channel" is not "nobody is working" - an operator
 * seeing 0 would reasonably conclude the fleet was down.
 */
export function LiveOnlineTile({ fallback }: { fallback: number }) {
  const { connected, devices } = useRealtime();

  const liveCount = [...devices.values()].filter((device) => device.live).length;
  const count = connected ? liveCount : fallback;

  return (
    <StatTile
      label="Online now"
      value={count}
      hint={connected ? 'Live - agents heartbeating' : 'Agents seen in the last 5 minutes'}
      tone={count > 0 ? 'success' : 'default'}
    />
  );
}
