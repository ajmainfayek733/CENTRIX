using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Input;
using Agent.Native.Sessions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Attendance;

/// <summary>
/// Translates raw Windows session/power/idle signals into immutable <see cref="AttendanceRawEvent"/>
/// rows. Contains no business rules itself (those live in <see cref="AttendanceEngine"/>) - this
/// class is purely an adapter from native events to the event log, per SRP.
/// </summary>
/// <remarks>
/// Idle-state correlation currently assumes a single interactive session per machine. True
/// per-session idle tracking for fast-user-switching arrives once the Active/Idle module's
/// tray-helper-to-service IPC channel is wired (each tray helper instance will report its own
/// session ID alongside its idle transitions).
/// </remarks>
public sealed class AttendanceCollectorService(
    ISessionEventSource sessionEvents,
    IPowerEventSource powerEvents,
    IIdleStateSource idleEvents,
    IWtsSessionInfoProvider wtsSessionInfo,
    IDeviceContextProvider deviceContext,
    IAttendanceRepository repository,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<AttendanceCollectorService> logger) : IHostedService
{
    private volatile int _lastKnownSessionId = -1;
    private volatile string _lastKnownUserSid = string.Empty;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged += OnSessionChanged;
        powerEvents.PowerChanged += OnPowerChanged;
        idleEvents.IdleStateChanged += OnIdleStateChanged;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged -= OnSessionChanged;
        powerEvents.PowerChanged -= OnPowerChanged;
        idleEvents.IdleStateChanged -= OnIdleStateChanged;
        return Task.CompletedTask;
    }

    private void OnSessionChanged(object? sender, SessionChangeNotification notification)
    {
        if (!policyProvider.Current.Attendance.Enabled)
        {
            return;
        }

        AttendanceEventType? eventType = notification.Reason switch
        {
            SessionChangeReasonKind.SessionLogon => AttendanceEventType.Login,
            SessionChangeReasonKind.SessionLogoff => AttendanceEventType.Logout,
            SessionChangeReasonKind.SessionLock => AttendanceEventType.Lock,
            SessionChangeReasonKind.SessionUnlock => AttendanceEventType.Unlock,
            _ => null
        };

        if (eventType is null)
        {
            return;
        }

        var userSid = wtsSessionInfo.TryGetUserSid(notification.SessionId);
        if (userSid is null)
        {
            logger.LogWarning(
                "Could not resolve user SID for session {SessionId}; dropping attendance event {EventType}.",
                notification.SessionId,
                eventType);
            return;
        }

        _lastKnownSessionId = notification.SessionId;
        _lastKnownUserSid = userSid;

        _ = RecordAsync(new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = deviceContext.Current.MachineId,
            UserSid = userSid,
            SessionId = notification.SessionId,
            IsRemoteSession = wtsSessionInfo.IsRemoteSession(notification.SessionId),
            OccurredAtUtc = notification.OccurredAtUtc,
            EventType = eventType.Value
        });
    }

    private void OnPowerChanged(object? sender, PowerChangeNotification notification)
    {
        if (!policyProvider.Current.Attendance.Enabled || _lastKnownSessionId < 0)
        {
            return;
        }

        AttendanceEventType? eventType = notification.Kind switch
        {
            PowerChangeKind.Suspend => AttendanceEventType.SleepStart,
            PowerChangeKind.ResumeAutomatic or PowerChangeKind.ResumeSuspend or PowerChangeKind.ResumeCritical
                => AttendanceEventType.SleepEnd,
            _ => null
        };

        if (eventType is null)
        {
            return;
        }

        _ = RecordAsync(new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = deviceContext.Current.MachineId,
            UserSid = _lastKnownUserSid,
            SessionId = _lastKnownSessionId,
            IsRemoteSession = wtsSessionInfo.IsRemoteSession(_lastKnownSessionId),
            OccurredAtUtc = notification.OccurredAtUtc,
            EventType = eventType.Value
        });
    }

    private void OnIdleStateChanged(object? sender, IdleStateChangeNotification notification)
    {
        if (!policyProvider.Current.Attendance.Enabled || _lastKnownSessionId < 0)
        {
            return;
        }

        _ = RecordAsync(new AttendanceRawEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = deviceContext.Current.MachineId,
            UserSid = _lastKnownUserSid,
            SessionId = _lastKnownSessionId,
            IsRemoteSession = wtsSessionInfo.IsRemoteSession(_lastKnownSessionId),
            OccurredAtUtc = notification.OccurredAtUtc,
            EventType = notification.IsIdle ? AttendanceEventType.IdleStart : AttendanceEventType.IdleEnd
        });
    }

    private async Task RecordAsync(AttendanceRawEvent rawEvent)
    {
        var validation = AttendanceValidator.Validate(rawEvent, clock.UtcNow);
        if (!validation.IsValid)
        {
            logger.LogWarning(
                "Rejected attendance event {EventType} for session {SessionId}: {Reason}",
                rawEvent.EventType,
                rawEvent.SessionId,
                validation.RejectionReason);
            return;
        }

        try
        {
            await repository.AppendEventAsync(rawEvent, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(
                ex,
                "Failed to persist attendance event {EventType} for session {SessionId}.",
                rawEvent.EventType,
                rawEvent.SessionId);
        }
    }
}
