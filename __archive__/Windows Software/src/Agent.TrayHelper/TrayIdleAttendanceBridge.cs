using System.Diagnostics;
using Agent.Collectors.Attendance;
using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Input;
using Agent.Native.Sessions;
using Microsoft.Extensions.Hosting;

namespace Agent.TrayHelper;

/// <summary>
/// Attendance's Login/Logout/Lock/Unlock/Sleep events come from the service (session/power
/// signals are Session-0 observable); its Idle events come from here instead, since idle
/// detection (ActivityCollectorService, in this same process) only works in an interactive
/// session. Both write to the same shared AttendanceRawEvent stream via IAttendanceRepository
/// pointed at the same database file.
/// </summary>
public sealed class TrayIdleAttendanceBridge(
    IIdleStateSource idleStateSource,
    IWtsSessionInfoProvider wtsSessionInfo,
    ICurrentUserProvider currentUserProvider,
    IDeviceContextProvider deviceContext,
    IAttendanceRepository repository,
    IPolicyProvider policyProvider) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        idleStateSource.IdleStateChanged += OnIdleStateChanged;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        idleStateSource.IdleStateChanged -= OnIdleStateChanged;
        return Task.CompletedTask;
    }

    private void OnIdleStateChanged(object? sender, IdleStateChangeNotification notification)
    {
        if (!policyProvider.Current.Attendance.Enabled)
        {
            return;
        }

        // The tray helper's own session, not "whichever session is active at the console" -
        // those differ when this process is running under RDP while someone else is on the
        // physical console.
        var sessionId = Process.GetCurrentProcess().SessionId;
        var userSid = currentUserProvider.GetCurrentUserSid();

        var rawEvent = new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = deviceContext.Current.MachineId,
            UserSid = userSid,
            SessionId = sessionId,
            IsRemoteSession = wtsSessionInfo.IsRemoteSession(sessionId),
            OccurredAtUtc = notification.OccurredAtUtc,
            EventType = notification.IsIdle ? AttendanceEventType.IdleStart : AttendanceEventType.IdleEnd
        };

        _ = repository.AppendEventAsync(rawEvent, CancellationToken.None);
    }
}
