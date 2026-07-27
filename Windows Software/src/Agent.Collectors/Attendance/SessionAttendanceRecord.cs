using Agent.Core.Intervals;

namespace Agent.Collectors.Attendance;

/// <summary>
/// One Login-to-Logout span for a single Windows session (console, RDP, or fast-user-switch
/// session are always tracked independently — never merged at this layer).
/// </summary>
public sealed record SessionAttendanceRecord
{
    public required int SessionId { get; init; }

    public required string UserSid { get; init; }

    public required string MachineId { get; init; }

    public required DateTimeOffset StartUtc { get; init; }

    public DateTimeOffset? EndUtc { get; init; }

    public required IReadOnlyList<TimeInterval> NonWorkingIntervals { get; init; }

    public bool IsOpen => EndUtc is null;
}
