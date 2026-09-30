namespace Agent.Core.Policy;

public sealed record ActivityPolicy
{
    public bool Enabled { get; init; } = true;

    public TimeSpan IdleThreshold { get; init; } = TimeSpan.FromMinutes(5);

    public bool MeetingDetectionEnabled { get; init; } = true;

    public TimeSpan MeetingOrPresentationFlagAfter { get; init; } = TimeSpan.FromMinutes(40);

    public IReadOnlyList<string> MeetingProcessNames { get; init; } =
        ["Teams", "Zoom", "slack", "GoogleMeet", "lync"];

    public IReadOnlyList<string> PresentationProcessNames { get; init; } =
        ["POWERPNT", "wpp"];

    /// <summary>
    /// High CPU with zero input (compiling, rendering) still counts as Active per the spec's
    /// "long compilation" edge case. Null CpuUsagePercent (counter unavailable) never triggers this.
    /// </summary>
    public double CpuBusyThresholdPercent { get; init; } = 50.0;
}
