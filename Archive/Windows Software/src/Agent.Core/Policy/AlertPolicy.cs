namespace Agent.Core.Policy;

public sealed record AlertPolicy
{
    public bool Enabled { get; init; } = true;

    public IdleAlertPolicy Idle { get; init; } = new();

    public BlacklistPolicy Blacklist { get; init; } = new();

    /// <summary>
    /// Outside-working-hours activity is tracked as overtime by default, not raised as a
    /// policy-violation alert. Admin opts in per confirmed requirement.
    /// </summary>
    public bool NotifyOutsideWorkingHours { get; init; }
}

public sealed record IdleAlertPolicy
{
    public bool Enabled { get; init; } = true;

    public TimeSpan WarningAfter { get; init; } = TimeSpan.FromMinutes(60);

    public TimeSpan HighAfter { get; init; } = TimeSpan.FromMinutes(70);

    public TimeSpan CriticalAfter { get; init; } = TimeSpan.FromMinutes(80);

    public TimeSpan NotifyManagerAfter { get; init; } = TimeSpan.FromMinutes(90);

    public TimeSpan RenotifyInterval { get; init; } = TimeSpan.FromMinutes(15);
}

public sealed record BlacklistPolicy
{
    public bool Enabled { get; init; }

    public IReadOnlyList<string> Categories { get; init; } = [];

    public IReadOnlyList<string> DomainPatterns { get; init; } = [];
}
