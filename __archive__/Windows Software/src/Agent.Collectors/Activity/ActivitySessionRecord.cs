using Agent.Core.Sync;

namespace Agent.Collectors.Activity;

public sealed record ActivitySessionRecord : ISyncableEvent
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required ActivityState State { get; init; }

    public required ActivityReason Reason { get; init; }

    public required DateTimeOffset StartTimeUtc { get; init; }

    public DateTimeOffset? EndTimeUtc { get; init; }

    public bool IsOpen => EndTimeUtc is null;

    DateTimeOffset ISyncableEvent.OccurredAtUtc => StartTimeUtc;

    string ISyncableEvent.Channel => "activity-session";

    SyncPriority ISyncableEvent.Priority => SyncPriority.Batched;
}
