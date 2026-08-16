namespace Agent.Core.Policy;

public sealed record AppSessionPolicy
{
    public bool Enabled { get; init; } = true;

    public TimeSpan PollInterval { get; init; } = TimeSpan.FromMilliseconds(1000);
}
