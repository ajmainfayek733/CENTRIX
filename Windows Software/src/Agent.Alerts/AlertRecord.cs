using Agent.Core.Sync;

namespace Agent.Alerts;

public sealed record AlertRecord : ISyncableEvent
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required AlertType Type { get; init; }

    public required AlertSeverity Severity { get; init; }

    public required AlertState State { get; init; }

    public required string Title { get; init; }

    public required string Message { get; init; }

    public required string ContextJson { get; init; }

    public required DateTimeOffset TriggeredAtUtc { get; init; }

    public DateTimeOffset? AcknowledgedAtUtc { get; init; }

    public DateTimeOffset? ResolvedAtUtc { get; init; }

    public DateTimeOffset? LastNotifiedAtUtc { get; init; }

    public required int EscalationLevel { get; init; }

    public required int NotificationCount { get; init; }

    DateTimeOffset ISyncableEvent.OccurredAtUtc => TriggeredAtUtc;

    string ISyncableEvent.Channel => "alert";

    SyncPriority ISyncableEvent.Priority => SyncPriority.Immediate;
}

public sealed record AlertEvaluationResult(AlertType Type, AlertSeverity Severity, string Title, string Message, string ContextJson);
