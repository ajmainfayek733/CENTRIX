/**
 * Which devices currently hold an agent socket.
 *
 * Deliberately a *soft* signal. It answers "is there an open signalling channel to this agent
 * right now", which is useful for deciding whether a force-sync will be delivered promptly — and
 * useless as a health or availability check, because a socket can stay open through a total
 * backend failure and can stay closed while an agent is happily syncing over HTTP.
 *
 * `devices.lastSeen`, written by authenticated HTTP requests, remains the online indicator the
 * dashboard reports. This is only ever shown alongside it, never instead of it.
 *
 * Memory: one entry per connected device, one socket id per connection, both removed on
 * disconnect and the device key deleted when its last socket goes. A device that reconnects in a
 * loop replaces entries rather than accumulating them, so the map is bounded by fleet size.
 */
class DevicePresenceRegistry {
  private readonly socketsByDevice = new Map<string, Set<string>>();

  /** @returns true when this is the device's first connection, i.e. presence actually changed. */
  add(deviceId: string, socketId: string): boolean {
    const existing = this.socketsByDevice.get(deviceId);

    if (existing) {
      existing.add(socketId);
      return false;
    }

    this.socketsByDevice.set(deviceId, new Set([socketId]));
    return true;
  }

  /** @returns true when the device has no sockets left, i.e. presence actually changed. */
  remove(deviceId: string, socketId: string): boolean {
    const sockets = this.socketsByDevice.get(deviceId);
    if (!sockets) return false;

    sockets.delete(socketId);
    if (sockets.size > 0) return false;

    // Drop the key as well as the set — leaving empty sets behind is how this map would grow
    // without bound across a long uptime with churning devices.
    this.socketsByDevice.delete(deviceId);
    return true;
  }

  isConnected(deviceId: string): boolean {
    return this.socketsByDevice.has(deviceId);
  }

  /** Snapshot for the dashboard's initial render; the map itself is never handed out. */
  connectedDeviceIds(): string[] {
    return [...this.socketsByDevice.keys()];
  }

  get size(): number {
    return this.socketsByDevice.size;
  }
}

export const devicePresence = new DevicePresenceRegistry();
