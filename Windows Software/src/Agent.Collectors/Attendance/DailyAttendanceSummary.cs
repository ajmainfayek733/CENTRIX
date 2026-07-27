namespace Agent.Collectors.Attendance;

/// <summary>
/// A recomputable view over raw events for one UTC calendar day — never itself the source of
/// truth, so it can be regenerated if attendance business rules change later.
/// </summary>
public sealed record DailyAttendanceSummary
{
    public required string UserSid { get; init; }

    public required string MachineId { get; init; }

    public required DateOnly DateUtc { get; init; }

    public required TimeSpan LoggedInDuration { get; init; }

    public required TimeSpan NonWorkingDuration { get; init; }

    public required TimeSpan ActiveDuration { get; init; }

    public required DateTimeOffset FirstLoginUtc { get; init; }

    public required DateTimeOffset LastActivityUtc { get; init; }
}
