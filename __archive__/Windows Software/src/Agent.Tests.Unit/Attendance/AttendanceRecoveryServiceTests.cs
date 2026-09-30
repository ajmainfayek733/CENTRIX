using Agent.Collectors.Attendance;
using Agent.Core.Time;
using Microsoft.Extensions.Logging.Abstractions;

namespace Agent.Tests.Unit.Attendance;

public class AttendanceRecoveryServiceTests
{
    private sealed class FakeClock(DateTimeOffset now) : ISystemClock
    {
        public DateTimeOffset UtcNow { get; } = now;
        public long MonotonicMilliseconds => 0;
    }

    private sealed class FakeRepository : IAttendanceRepository
    {
        public List<AttendanceRawEvent> Events { get; } = [];

        public Task AppendEventAsync(AttendanceRawEvent rawEvent, CancellationToken cancellationToken)
        {
            Events.Add(rawEvent);
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<AttendanceRawEvent>> GetEventsAsync(DateTimeOffset? sinceUtc, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<AttendanceRawEvent>>(Events.ToList());
    }

    [Fact]
    public async Task RecoverAsync_ClosesDanglingSessionAndReopensForContinuity()
    {
        var login = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var restart = login.AddHours(1);
        var repository = new FakeRepository();
        repository.Events.Add(new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = "machine-1",
            UserSid = "S-1-5-21-user",
            SessionId = 1,
            IsRemoteSession = false,
            OccurredAtUtc = login,
            EventType = AttendanceEventType.Login
        });

        var service = new AttendanceRecoveryService(repository, new FakeClock(restart), NullLogger<AttendanceRecoveryService>.Instance);
        await service.RecoverAsync(CancellationToken.None);

        var sessions = AttendanceEngine.BuildSessions(repository.Events);
        Assert.Equal(2, sessions.Count);
        Assert.False(sessions[0].IsOpen);
        Assert.Equal(restart, sessions[0].EndUtc);
        Assert.True(sessions[1].IsOpen);
        Assert.Equal(restart.AddTicks(1), sessions[1].StartUtc);
    }

    [Fact]
    public async Task RecoverAsync_WithNoOpenSessions_DoesNothing()
    {
        var login = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var repository = new FakeRepository();
        repository.Events.Add(new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = "machine-1",
            UserSid = "S-1-5-21-user",
            SessionId = 1,
            IsRemoteSession = false,
            OccurredAtUtc = login,
            EventType = AttendanceEventType.Login
        });
        repository.Events.Add(new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = "machine-1",
            UserSid = "S-1-5-21-user",
            SessionId = 1,
            IsRemoteSession = false,
            OccurredAtUtc = login.AddHours(8),
            EventType = AttendanceEventType.Logout
        });

        var service = new AttendanceRecoveryService(repository, new FakeClock(login.AddHours(9)), NullLogger<AttendanceRecoveryService>.Instance);
        await service.RecoverAsync(CancellationToken.None);

        Assert.Equal(2, repository.Events.Count);
    }
}
