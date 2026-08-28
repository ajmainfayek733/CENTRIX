namespace Agent.Core.Policy;

public sealed record BrowserMonitorPolicy
{
    public bool Enabled { get; init; } = true;

    public TimeSpan UiaTimeout { get; init; } = TimeSpan.FromMilliseconds(500);

    public int MaxRetryAttempts { get; init; } = 3;
}
