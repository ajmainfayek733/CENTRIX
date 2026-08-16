namespace Agent.Core.Policy;

public sealed record SyncPolicy
{
    public TimeSpan BatchInterval { get; init; } = TimeSpan.FromMinutes(2);

    public int MaxBatchSize { get; init; } = 500;

    public TimeSpan MinRetryBackoff { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan MaxRetryBackoff { get; init; } = TimeSpan.FromMinutes(2);
}
