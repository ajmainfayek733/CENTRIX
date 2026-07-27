using Agent.Core.Sync;

namespace Agent.Collectors.AppSession;

/// <summary>
/// Persisted immediately on open (EndTimeUtc null) so a crash mid-session still leaves a durable
/// row for recovery to find and close, then completed in place when the session closes. Only the
/// completed row is ever enqueued to the sync outbox — the backend never sees a half-open session.
/// </summary>
public sealed record AppSessionRecord : ISyncableEvent
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required int WindowsSessionId { get; init; }

    public required AppSessionKind Kind { get; init; }

    public required int ProcessId { get; init; }

    public required string Executable { get; init; }

    public required string WindowTitle { get; init; }

    public required DateTimeOffset StartTimeUtc { get; init; }

    public DateTimeOffset? EndTimeUtc { get; init; }

    public string? ProductivityTag { get; init; }

    public bool IsOpen => EndTimeUtc is null;

    public TimeSpan? Duration => EndTimeUtc - StartTimeUtc;

    DateTimeOffset ISyncableEvent.OccurredAtUtc => StartTimeUtc;

    string ISyncableEvent.Channel => "app-session";

    SyncPriority ISyncableEvent.Priority => SyncPriority.Batched;
}
