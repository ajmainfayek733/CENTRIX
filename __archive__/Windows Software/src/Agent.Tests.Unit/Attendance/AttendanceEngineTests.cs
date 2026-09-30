using Agent.Collectors.Attendance;

namespace Agent.Tests.Unit.Attendance;

public class AttendanceEngineTests
{
    private const string MachineId = "machine-1";
    private const string UserSid = "S-1-5-21-user";
    private const int SessionId = 1;

    private static AttendanceRawEvent Evt(AttendanceEventType type, DateTimeOffset atUtc, int sessionId = SessionId) => new()
    {
        ClientEventId = Guid.NewGuid(),
        MachineId = MachineId,
        UserSid = UserSid,
        SessionId = sessionId,
        IsRemoteSession = false,
        OccurredAtUtc = atUtc,
        EventType = type
    };

    [Fact]
    public void IdleTime_IsSubtractedFromLoggedInDuration()
    {
        var start = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, start),
            Evt(AttendanceEventType.IdleStart, start.AddHours(2)),
            Evt(AttendanceEventType.IdleEnd, start.AddHours(8)),
            Evt(AttendanceEventType.Logout, start.AddHours(8))
        };

        var sessions = AttendanceEngine.BuildSessions(events);
        var summaries = AttendanceSummaryBuilder.BuildDailySummaries(sessions, start.AddHours(8));

        var summary = Assert.Single(summaries);
        Assert.Equal(TimeSpan.FromHours(8), summary.LoggedInDuration);
        Assert.Equal(TimeSpan.FromHours(6), summary.NonWorkingDuration);
        Assert.Equal(TimeSpan.FromHours(2), summary.ActiveDuration);
    }

    [Fact]
    public void OverlappingLockAndIdle_AreMergedNotDoubleSubtracted()
    {
        // Idle: 09:00-09:30 (30 min). Lock: 09:10-09:35 (25 min). They overlap by 20 min, so the
        // true non-working span is 09:00-09:35 = 35 minutes, not 30+25=55.
        var start = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, start),
            Evt(AttendanceEventType.IdleStart, start),
            Evt(AttendanceEventType.Lock, start.AddMinutes(10)),
            Evt(AttendanceEventType.IdleEnd, start.AddMinutes(30)),
            Evt(AttendanceEventType.Unlock, start.AddMinutes(35)),
            Evt(AttendanceEventType.Logout, start.AddHours(1))
        };

        var sessions = AttendanceEngine.BuildSessions(events);
        var summaries = AttendanceSummaryBuilder.BuildDailySummaries(sessions, start.AddHours(1));

        var summary = Assert.Single(summaries);
        Assert.Equal(TimeSpan.FromMinutes(35), summary.NonWorkingDuration);
        Assert.Equal(TimeSpan.FromMinutes(25), summary.ActiveDuration);
    }

    [Fact]
    public void SleepPeriod_IsNeverCountedAsActiveWork()
    {
        var start = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, start),
            Evt(AttendanceEventType.SleepStart, start.AddHours(1)),
            Evt(AttendanceEventType.SleepEnd, start.AddHours(9)),
            Evt(AttendanceEventType.Logout, start.AddHours(10))
        };

        var sessions = AttendanceEngine.BuildSessions(events);
        var summaries = AttendanceSummaryBuilder.BuildDailySummaries(sessions, start.AddHours(10));

        var summary = Assert.Single(summaries);
        Assert.Equal(TimeSpan.FromHours(8), summary.NonWorkingDuration);
        Assert.Equal(TimeSpan.FromHours(2), summary.ActiveDuration);
    }

    [Fact]
    public void SessionCrossingMidnight_SplitsIntoTwoDailySummaries()
    {
        var login = new DateTimeOffset(2026, 1, 5, 23, 0, 0, TimeSpan.Zero);
        var logout = new DateTimeOffset(2026, 1, 6, 8, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, login),
            Evt(AttendanceEventType.Logout, logout)
        };

        var sessions = AttendanceEngine.BuildSessions(events);
        var summaries = AttendanceSummaryBuilder.BuildDailySummaries(sessions, logout);

        Assert.Equal(2, summaries.Count);
        Assert.Equal(new DateOnly(2026, 1, 5), summaries[0].DateUtc);
        Assert.Equal(TimeSpan.FromHours(1), summaries[0].LoggedInDuration);
        Assert.Equal(new DateOnly(2026, 1, 6), summaries[1].DateUtc);
        Assert.Equal(TimeSpan.FromHours(8), summaries[1].LoggedInDuration);
    }

    [Fact]
    public void MultipleLoginLogoutPairsOnSameDay_AreSummed()
    {
        var day = new DateTimeOffset(2026, 1, 5, 0, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, day.AddHours(9)),
            Evt(AttendanceEventType.Logout, day.AddHours(12)),
            Evt(AttendanceEventType.Login, day.AddHours(13)),
            Evt(AttendanceEventType.Logout, day.AddHours(17))
        };

        var sessions = AttendanceEngine.BuildSessions(events);
        var summaries = AttendanceSummaryBuilder.BuildDailySummaries(sessions, day.AddHours(17));

        var summary = Assert.Single(summaries);
        Assert.Equal(TimeSpan.FromHours(7), summary.LoggedInDuration);
    }

    [Fact]
    public void DuplicateLockEventWithoutInterveningUnlock_DoesNotExtendOrDuplicateInterval()
    {
        var start = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, start),
            Evt(AttendanceEventType.Lock, start.AddMinutes(10)),
            Evt(AttendanceEventType.Lock, start.AddMinutes(15)), // duplicate/stray, should be a no-op
            Evt(AttendanceEventType.Unlock, start.AddMinutes(20)),
            Evt(AttendanceEventType.Logout, start.AddHours(1))
        };

        var sessions = AttendanceEngine.BuildSessions(events);
        var session = Assert.Single(sessions);
        var interval = Assert.Single(session.NonWorkingIntervals);
        Assert.Equal(TimeSpan.FromMinutes(10), interval.Duration);
    }

    [Fact]
    public void DanglingOpenSession_IsClosedAtRecoveryTimeAndNotLeftOpen()
    {
        var login = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var restart = new DateTimeOffset(2026, 1, 5, 10, 0, 0, TimeSpan.Zero);
        var events = new[] { Evt(AttendanceEventType.Login, login) };

        var sessions = AttendanceEngine.BuildSessions(events, recoveryCloseAtUtc: restart);

        var session = Assert.Single(sessions);
        Assert.False(session.IsOpen);
        Assert.Equal(restart, session.EndUtc);
    }

    [Fact]
    public void WithoutRecoveryTimestamp_DanglingSessionIsReturnedAsOpen()
    {
        var login = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var events = new[] { Evt(AttendanceEventType.Login, login) };

        var sessions = AttendanceEngine.BuildSessions(events);

        var session = Assert.Single(sessions);
        Assert.True(session.IsOpen);
        Assert.Null(session.EndUtc);
    }

    [Fact]
    public void ConcurrentConsoleAndRdpSessions_AreTrackedIndependently()
    {
        var start = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, start, sessionId: 1),
            Evt(AttendanceEventType.Login, start.AddMinutes(5), sessionId: 2),
            Evt(AttendanceEventType.Logout, start.AddHours(1), sessionId: 1),
            Evt(AttendanceEventType.Logout, start.AddHours(2), sessionId: 2)
        };

        var sessions = AttendanceEngine.BuildSessions(events);

        Assert.Equal(2, sessions.Count);
        Assert.Contains(sessions, s => s.SessionId == 1 && s.EndUtc == start.AddHours(1));
        Assert.Contains(sessions, s => s.SessionId == 2 && s.EndUtc == start.AddHours(2));
    }

    [Fact]
    public void SecondLoginWithoutLogout_ClosesFirstSessionAtSecondLoginTime()
    {
        var first = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var second = first.AddHours(1);
        var events = new[]
        {
            Evt(AttendanceEventType.Login, first),
            Evt(AttendanceEventType.Login, second)
        };

        var sessions = AttendanceEngine.BuildSessions(events, recoveryCloseAtUtc: second.AddMinutes(30));

        Assert.Equal(2, sessions.Count);
        Assert.Equal(second, sessions[0].EndUtc);
        Assert.True(sessions[1].IsOpen == false);
    }
}
