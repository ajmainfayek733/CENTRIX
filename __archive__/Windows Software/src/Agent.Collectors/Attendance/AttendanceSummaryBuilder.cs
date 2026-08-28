using Agent.Core.Intervals;

namespace Agent.Collectors.Attendance;

/// <summary>
/// Derives daily summaries from session records. Splits at UTC midnight (not local midnight -
/// the spec forbids relying on local time internally) and merges overlapping non-working
/// intervals (idle/lock/sleep) before subtracting, so overlapping periods are never double
/// counted.
/// </summary>
public static class AttendanceSummaryBuilder
{
    public static IReadOnlyList<DailyAttendanceSummary> BuildDailySummaries(
        IEnumerable<SessionAttendanceRecord> sessions,
        DateTimeOffset nowUtcForOpenSessions)
    {
        var daySlices = new List<DaySlice>();

        foreach (var session in sessions)
        {
            var effectiveEnd = session.EndUtc ?? nowUtcForOpenSessions;
            if (effectiveEnd <= session.StartUtc)
            {
                continue;
            }

            foreach (var slice in SplitAtUtcMidnight(session.StartUtc, effectiveEnd))
            {
                var nonWorkingInSlice = session.NonWorkingIntervals
                    .Where(nw => nw.Overlaps(slice))
                    .Select(nw => new TimeInterval(
                        nw.Start > slice.Start ? nw.Start : slice.Start,
                        nw.End < slice.End ? nw.End : slice.End))
                    .ToList();

                daySlices.Add(new DaySlice(
                    DateOnly.FromDateTime(slice.Start.UtcDateTime),
                    session.UserSid,
                    session.MachineId,
                    slice,
                    nonWorkingInSlice));
            }
        }

        return daySlices
            .GroupBy(s => (s.UserSid, s.MachineId, s.Date))
            .Select(group =>
            {
                var loggedIn = TimeSpan.FromTicks(group.Sum(s => s.LoggedIn.Duration.Ticks));
                var nonWorking = IntervalMerger.TotalDuration(group.SelectMany(s => s.NonWorking));
                var active = loggedIn - nonWorking;

                return new DailyAttendanceSummary
                {
                    UserSid = group.Key.UserSid,
                    MachineId = group.Key.MachineId,
                    DateUtc = group.Key.Date,
                    LoggedInDuration = loggedIn,
                    NonWorkingDuration = nonWorking,
                    ActiveDuration = active < TimeSpan.Zero ? TimeSpan.Zero : active,
                    FirstLoginUtc = group.Min(s => s.LoggedIn.Start),
                    LastActivityUtc = group.Max(s => s.LoggedIn.End)
                };
            })
            .OrderBy(s => s.DateUtc)
            .ToList();
    }

    private static IEnumerable<TimeInterval> SplitAtUtcMidnight(DateTimeOffset start, DateTimeOffset end)
    {
        var cursor = start;
        while (cursor < end)
        {
            var nextMidnightUtc = new DateTimeOffset(cursor.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);
            var sliceEnd = nextMidnightUtc < end ? nextMidnightUtc : end;
            yield return new TimeInterval(cursor, sliceEnd);
            cursor = sliceEnd;
        }
    }

    private sealed record DaySlice(
        DateOnly Date,
        string UserSid,
        string MachineId,
        TimeInterval LoggedIn,
        IReadOnlyList<TimeInterval> NonWorking);
}
