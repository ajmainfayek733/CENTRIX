"use client";

import { useDeviceLiveness, useNow } from "@/components/RealtimeProvider";
import { formatRelative } from "@/lib/format";
import { StatusDot, Badge } from "@/components/ui";

/**
 * A device's activeness, updated by heartbeat rather than by page refresh.
 *
 * TWO SOURCES, AND THE ORDER MATTERS:
 *
 *   1. Live presence from the socket. Present only while an agent is connected and heartbeating,
 *      and it is the better answer whenever it exists - it is seconds old by construction.
 *   2. The server-rendered `lastSeen` this page was built with. The fallback for a device with no
 *      live channel: switched off, out of the office, or an agent that cannot reach the socket
 *      endpoint through a proxy.
 *
 * Deliberately never shows "online" from source 2 alone at high confidence. `lastSeen` says when
 * the device was last heard from, which after a few minutes is a statement about the past, not
 * about now.
 */
export function LiveDeviceStatus({
  deviceId,
  lastSeen,
  isActive,
}: {
  /** Device row id - the same id the presence events carry. */
  deviceId: string;
  /** Server-rendered fallback, from `devices.lastSeen`. */
  lastSeen: string | null;
  /** False when an admin has deactivated the device, which outranks any liveness. */
  isActive: boolean;
}) {
  const liveness = useDeviceLiveness(deviceId);

  if (!isActive) return <Badge tone="danger">Deactivated</Badge>;

  if (liveness?.live) {
    return (
      <span className="flex items-center justify-end gap-2">
        <StatusDot online />
        <span className="text-sm font-medium text-brand">
          {liveness.userPresent ? "Active now" : "Online - no user"}
        </span>
      </span>
    );
  }

  // Prefer the live channel's timestamp when we have one: it is newer than whatever this page was
  // server-rendered with, and it is the only one that keeps moving without a navigation.
  const seenAt = liveness?.lastSeen ?? lastSeen;

  return (
    <span className="flex items-center justify-end gap-2">
      <StatusDot online={false} />
      <span className="text-sm text-text-secondary">{formatRelative(seenAt)}</span>
    </span>
  );
}

/**
 * The dot on its own, for tables that show the name and the timestamp in separate columns.
 */
export function LiveStatusDot({
  deviceId,
  lastSeen,
  isActive,
}: {
  deviceId: string;
  lastSeen: string | null;
  isActive: boolean;
}) {
  const liveness = useDeviceLiveness(deviceId);
  const now = useNow();

  // With no live channel, fall back to the same window the server's reports use, so a device is
  // not called online here and offline on the overview.
  const recentlySeen = !!lastSeen && now - new Date(lastSeen).getTime() < FALLBACK_ONLINE_WINDOW_MS;

  return <StatusDot online={isActive && (liveness?.live ?? recentlySeen)} />;
}

/**
 * How recently `lastSeen` must be for a device with no live channel to still read as online.
 *
 * Matches ONLINE_WINDOW_MS in the backend's reportService. The two are the same judgement about
 * the same data, and if they drift the overview count stops matching the device list.
 */
const FALLBACK_ONLINE_WINDOW_MS = 5 * 60 * 1000;
