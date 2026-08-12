namespace Agent.Core.Sync;

/// <summary>
/// Backing store for the outbox pattern: every collector enqueues here in the same local
/// transaction as its own domain write, and the Sync Worker only ever talks to this contract -
/// it never sees per-module schemas.
/// </summary>
public interface IOutboxRepository
{
    Task EnqueueAsync(ISyncableEvent syncableEvent, string payloadJson, CancellationToken cancellationToken);

    Task<IReadOnlyList<OutboxRecord>> GetPendingAsync(string channel, int maxBatchSize, CancellationToken cancellationToken);

    Task MarkSyncedAsync(IReadOnlyList<Guid> clientEventIds, CancellationToken cancellationToken);

    Task IncrementAttemptsAsync(IReadOnlyList<Guid> clientEventIds, CancellationToken cancellationToken);

    Task<int> PurgeExpiredUnsyncedAsync(TimeSpan maxAge, CancellationToken cancellationToken);

    Task<IReadOnlyList<string>> GetPendingChannelsAsync(CancellationToken cancellationToken);
}

public sealed record OutboxRecord(
    Guid ClientEventId,
    string Channel,
    string PayloadJson,
    SyncPriority Priority,
    DateTimeOffset CreatedAtUtc,
    int Attempts);
