namespace Agent.Core.Sync;

/// <summary>
/// Implemented by every collector event so the generic Sync Worker (Agent.Sync) can queue it
/// without knowing about module-specific schemas.
/// </summary>
public interface ISyncableEvent
{
    Guid ClientEventId { get; }

    string Channel { get; }

    DateTimeOffset OccurredAtUtc { get; }

    SyncPriority Priority { get; }
}
