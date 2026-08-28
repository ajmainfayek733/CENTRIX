using Agent.Collectors.Attendance;

namespace Agent.Tests.Unit.Attendance;

public class AttendanceValidatorTests
{
    private static AttendanceRawEvent Evt(DateTimeOffset atUtc) => new()
    {
        ClientEventId = Guid.NewGuid(),
        MachineId = "machine-1",
        UserSid = "S-1-5-21-user",
        SessionId = 1,
        IsRemoteSession = false,
        OccurredAtUtc = atUtc,
        EventType = AttendanceEventType.Login
    };

    [Fact]
    public void FutureTimestamp_BeyondClockSkewTolerance_IsRejected()
    {
        var now = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var result = AttendanceValidator.Validate(Evt(now.AddHours(1)), now);

        Assert.False(result.IsValid);
    }

    [Fact]
    public void TimestampWithinClockSkewTolerance_IsAccepted()
    {
        var now = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var result = AttendanceValidator.Validate(Evt(now.AddSeconds(30)), now);

        Assert.True(result.IsValid);
    }

    [Fact]
    public void PastTimestamp_IsAccepted()
    {
        var now = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var result = AttendanceValidator.Validate(Evt(now.AddDays(-1)), now);

        Assert.True(result.IsValid);
    }
}
