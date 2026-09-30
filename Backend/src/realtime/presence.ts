/**
 * Live agent presence: which devices hold a socket, and when each last actually spoke.
 *
 * THE DISTINCTION THAT MATTERS. There are two different signals here and they are not the same
 * strength:
 *
 *   - A socket being *open* is weak evidence. A half-open TCP connection can survive for minutes
 *     after a workstation has been unplugged, suspended or lost its network - the operating
 *     system has no reason to notice until something is sent. A dashboard that showed "online"
 *     purely because a socket object existed would lie for as long as that takes.
 *
 *   - A heartbeat *received* is strong evidence. It is positive proof that the agent was running
 *     and reachable at a known instant. That is why agents emit one on a fixed interval rather
 *     than relying on the connection to speak for them, and why `lastHeartbeatAt` - not the
 *     presence of an entry in this map - is what liveness is derived from.
 *
 * So a device is reported as live when its most recent heartbeat is inside the expected interval
 * plus a grace margin. Holding a socket without heartbeating is treated as not live, which is
 * precisely the half-open case.
 *
 * Memory: one entry per connected device, removed when its last socket closes. A device that
 * reconnects in a loop replaces its entry rather than accumulating, so this is bounded by fleet
 * size, not by uptime.
 */

interface DevicePresence {
  /** Every socket this device currently holds. More than one during a reconnect overlap. */
  socketIds: Set<string>;
  /** When the agent last actually said something. The signal liveness is derived from. */
  lastHeartbeatAt: number;
  /**
   * Owning organization, recorded so a snapshot can be scoped to one tenant.
   *
   * Without it `snapshot()` returns every connected device to whichever dashboard asks, which is
   * a cross-tenant disclosure the moment a second organization exists - and one that would not
   * show up in a single-org deployment until it was too late to notice quietly.
   */
  organizationId: string;
}

class DevicePresenceRegistry {
  private readonly byDevice = new Map<string, DevicePresence>();

  /** @returns true when this is the device's first connection, i.e. presence actually changed. */
  add(deviceId: string, socketId: string, organizationId: string): boolean {
    const existing = this.byDevice.get(deviceId);

    if (existing) {
      existing.socketIds.add(socketId);
      return false;
    }

    // Connecting counts as being heard from - the handshake was authenticated traffic.
    this.byDevice.set(deviceId, {
      socketIds: new Set([socketId]),
      lastHeartbeatAt: Date.now(),
      organizationId,
    });
    return true;
  }

  /** @returns true when the device has no sockets left, i.e. presence actually changed. */
  remove(deviceId: string, socketId: string): boolean {
    const presence = this.byDevice.get(deviceId);
    if (!presence) return false;

    presence.socketIds.delete(socketId);
    if (presence.socketIds.size > 0) return false;

    // Drop the key as well as the set - leaving empty entries behind is how this map would grow
    // without bound across a long uptime with churning devices.
    this.byDevice.delete(deviceId);
    return true;
  }

  /** Records a heartbeat. Ignored for a device with no socket, which cannot have sent one. */
  heartbeat(deviceId: string): void {
    const presence = this.byDevice.get(deviceId);
    if (presence) presence.lastHeartbeatAt = Date.now();
  }

  /**
   * Whether the agent is live right now.
   *
   * Not "is a socket open" - see the note at the top of this file. A device holding a socket it
   * has stopped heartbeating on is reported as not live, because that is the shape a silently
   * dead connection takes.
   */
  isLive(deviceId: string, maxSilenceMs: number): boolean {
    const presence = this.byDevice.get(deviceId);
    if (!presence) return false;
    return Date.now() - presence.lastHeartbeatAt <= maxSilenceMs;
  }

  /** True when a command sent now would reach the agent's socket. */
  isConnected(deviceId: string): boolean {
    return this.byDevice.has(deviceId);
  }

  /**
   * Snapshot for a dashboard's initial render, scoped to one organization.
   *
   * The organization filter is not optional and there is no unscoped variant on purpose: a
   * caller that forgets to pass it should fail to compile rather than quietly return the whole
   * fleet to one tenant's dashboard. The map itself is never handed out.
   */
  snapshot(
    organizationId: string,
    maxSilenceMs: number
  ): Array<{ deviceId: string; live: boolean; lastHeartbeatAt: string }> {
    return [...this.byDevice.entries()]
      .filter(([, presence]) => presence.organizationId === organizationId)
      .map(([deviceId, presence]) => ({
        deviceId,
        live: Date.now() - presence.lastHeartbeatAt <= maxSilenceMs,
        lastHeartbeatAt: new Date(presence.lastHeartbeatAt).toISOString(),
      }));
  }

  connectedDeviceIds(): string[] {
    return [...this.byDevice.keys()];
  }

  get size(): number {
    return this.byDevice.size;
  }
}

export const devicePresence = new DevicePresenceRegistry();
