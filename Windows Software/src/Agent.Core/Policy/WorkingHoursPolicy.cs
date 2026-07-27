namespace Agent.Core.Policy;

/// <summary>
/// Stored and evaluated against the machine's local time zone for display purposes only;
/// all underlying event timestamps remain UTC.
/// </summary>
public sealed record WorkingHoursPolicy
{
    public TimeOnly StartLocal { get; init; } = new(8, 0);

    public TimeOnly EndLocal { get; init; } = new(17, 0);

    public IReadOnlyList<DayOfWeek> WorkingDays { get; init; } =
    [
        DayOfWeek.Monday,
        DayOfWeek.Tuesday,
        DayOfWeek.Wednesday,
        DayOfWeek.Thursday,
        DayOfWeek.Friday
    ];
}
