namespace Agent.Core.Policy;

public sealed record AttendancePolicy
{
    public bool Enabled { get; init; } = true;

    public TimeSpan IdleThreshold { get; init; } = TimeSpan.FromMinutes(5);
}
