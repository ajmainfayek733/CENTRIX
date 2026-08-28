using Agent.Core.Events;
using Agent.Core.Sync;

namespace Agent.Collectors.Attendance;

/// <summary>
/// Immutable raw signal. Attendance summaries are always derived from these, never stored
/// as mutable accumulators, so recalculation is possible if business rules change.
/// </summary>
public sealed record AttendanceRawEvent : TelemetryEvent, ISyncableEvent
{
    public required AttendanceEventType EventType { get; init; }

    public required int SessionId { get; init; }

    public required bool IsRemoteSession { get; init; }

    /// <summary>Set for synthetic events the agent generates itself, e.g. "ServiceRestartRecovery".</summary>
    public string? Reason { get; init; }

    string ISyncableEvent.Channel => "attendance";

    SyncPriority ISyncableEvent.Priority => SyncPriority.Batched;
}
