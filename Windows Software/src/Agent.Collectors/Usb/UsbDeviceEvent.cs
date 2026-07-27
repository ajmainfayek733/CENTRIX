using Agent.Core.Sync;
using Agent.Native;

namespace Agent.Collectors.Usb;

/// <summary>
/// Immediate sync priority — a USB insertion needs to reach the Alert engine's
/// UsbViolationRule without waiting for the next 2-minute batch tick.
/// </summary>
public sealed record UsbDeviceEvent : ISyncableEvent
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required string PnpDeviceId { get; init; }

    public string? SerialNumber { get; init; }

    public string? Model { get; init; }

    public string? Manufacturer { get; init; }

    public long? CapacityBytes { get; init; }

    public required IReadOnlyList<UsbVolumeSnapshot> Volumes { get; init; }

    public required UsbEventType EventType { get; init; }

    public required DateTimeOffset OccurredAtUtc { get; init; }

    string ISyncableEvent.Channel => "usb-device";

    SyncPriority ISyncableEvent.Priority => SyncPriority.Immediate;
}
