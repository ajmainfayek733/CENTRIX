namespace Agent.Core.Events;

/// <summary>
/// Common shape for every immutable event a collector emits. <see cref="ClientEventId"/> is the
/// idempotency key the backend must dedupe on across retried sync batches.
/// </summary>
public abstract record TelemetryEvent
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required DateTimeOffset OccurredAtUtc { get; init; }
}
