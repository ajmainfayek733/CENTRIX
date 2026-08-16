using Agent.Core.Time;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Attendance;

/// <summary>
/// Runs once at startup. Finds any session left open by a prior crash/kill/power-loss and
/// closes it at the current time with a synthetic Logout, then immediately reopens a new
/// session for continuity - "find open session, close at restart, create new session" per
/// the Attendance and App-Session specs' crash-recovery requirements. Never leaves a dangling
/// open session across a restart.
/// </summary>
public sealed class AttendanceRecoveryService(
    IAttendanceRepository repository,
    ISystemClock clock,
    ILogger<AttendanceRecoveryService> logger)
{
    private static readonly TimeSpan RecoveryLookback = TimeSpan.FromDays(7);

    public async Task RecoverAsync(CancellationToken cancellationToken)
    {
        var nowUtc = clock.UtcNow;
        var events = await repository.GetEventsAsync(nowUtc - RecoveryLookback, cancellationToken).ConfigureAwait(false);
        var sessions = AttendanceEngine.BuildSessions(events);

        foreach (var open in sessions.Where(s => s.IsOpen))
        {
            logger.LogWarning(
                "Recovering dangling open attendance session {SessionId} for {UserSid}, started {StartUtc}.",
                open.SessionId,
                open.UserSid,
                open.StartUtc);

            var logout = new AttendanceRawEvent
            {
                ClientEventId = Guid.NewGuid(),
                MachineId = open.MachineId,
                UserSid = open.UserSid,
                SessionId = open.SessionId,
                IsRemoteSession = false,
                OccurredAtUtc = nowUtc,
                EventType = AttendanceEventType.Logout,
                Reason = "ServiceRestartRecovery"
            };

            await repository.AppendEventAsync(logout, cancellationToken).ConfigureAwait(false);

            // +1 tick keeps this strictly after the synthetic Logout: same-instant events fall
            // back to an arbitrary (GUID-based) tie-break in the engine, which could process the
            // Login first and corrupt the recovered session boundary.
            var resumedLogin = logout with
            {
                ClientEventId = Guid.NewGuid(),
                EventType = AttendanceEventType.Login,
                OccurredAtUtc = nowUtc.AddTicks(1)
            };

            await repository.AppendEventAsync(resumedLogin, cancellationToken).ConfigureAwait(false);
        }
    }
}
