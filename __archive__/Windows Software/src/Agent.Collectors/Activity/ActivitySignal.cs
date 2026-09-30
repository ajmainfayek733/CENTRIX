namespace Agent.Collectors.Activity;

/// <summary>
/// Everything the Decision Engine needs for one evaluation. Callers compute
/// <see cref="ForegroundContinuousDuration"/> themselves (the App Session tracker already knows
/// this) rather than the engine re-deriving foreground continuity itself.
/// </summary>
public sealed record ActivitySignal
{
    public required DateTimeOffset AtUtc { get; init; }

    public required TimeSpan IdleInputDuration { get; init; }

    public required bool IsSessionLocked { get; init; }

    public required bool IsSleeping { get; init; }

    public required bool IsOffline { get; init; }

    public string? ForegroundExecutable { get; init; }

    public TimeSpan ForegroundContinuousDuration { get; init; }

    public double? CpuUsagePercent { get; init; }
}
