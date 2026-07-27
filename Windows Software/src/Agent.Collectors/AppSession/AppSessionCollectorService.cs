using System.IO;
using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Input;
using Agent.Native.Sessions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.AppSession;

/// <summary>
/// Drives <see cref="AppSessionTracker"/> from three input sources: a foreground-window poll
/// timer, and the Lock/Unlock/Sleep/Resume/RDP-disconnect native events also used by Attendance.
/// While Locked, Idle, or Sleeping, the poll loop is suppressed entirely — "never allow app
/// sessions while locked" — and only the pseudo-state events themselves drive transitions.
/// </summary>
/// <remarks>
/// GetForegroundWindow only returns meaningful data in the interactive session, so this runs
/// in the per-user tray helper, writing directly to the same encrypted database the service
/// uses (see Agent.TrayHelper's composition root for why no IPC channel is needed).
/// </remarks>
public sealed class AppSessionCollectorService(
    IForegroundWindowMonitor foregroundWindowMonitor,
    ISessionEventSource sessionEvents,
    IPowerEventSource powerEvents,
    IIdleStateSource idleEvents,
    ICurrentUserProvider currentUserProvider,
    IDeviceContextProvider deviceContext,
    IAppSessionRepository repository,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<AppSessionCollectorService> logger) : IHostedService, IDisposable
{
    private readonly AppSessionTracker _tracker = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Timer? _pollTimer;
    private Guid? _currentClientEventId;
    private volatile int _windowsSessionId = -1;
    private readonly string _userSid = currentUserProvider.GetCurrentUserSid();
    private volatile bool _suppressPolling;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged += OnSessionChanged;
        powerEvents.PowerChanged += OnPowerChanged;
        idleEvents.IdleStateChanged += OnIdleStateChanged;

        var pollInterval = policyProvider.Current.AppSession.PollInterval;
        _pollTimer = new Timer(_ => _ = PollAsync(), null, pollInterval, pollInterval);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged -= OnSessionChanged;
        powerEvents.PowerChanged -= OnPowerChanged;
        idleEvents.IdleStateChanged -= OnIdleStateChanged;
        _pollTimer?.Dispose();

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await CloseCurrentRowIfOpenAsync(clock.UtcNow, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose()
    {
        _pollTimer?.Dispose();
        _gate.Dispose();
    }

    private async Task PollAsync()
    {
        if (_suppressPolling || !policyProvider.Current.AppSession.Enabled)
        {
            return;
        }

        var snapshot = foregroundWindowMonitor.GetCurrentForegroundWindow();
        var state = snapshot is null
            ? AppSessionState.Desktop
            : AppSessionState.Application(snapshot.ProcessId, snapshot.ExecutablePath, snapshot.WindowTitle);

        await HandleObservationAsync(state, clock.UtcNow).ConfigureAwait(false);
    }

    private void OnSessionChanged(object? sender, SessionChangeNotification notification)
    {
        _windowsSessionId = notification.SessionId;

        switch (notification.Reason)
        {
            case SessionChangeReasonKind.SessionLock:
                _suppressPolling = true;
                _ = HandleObservationAsync(AppSessionState.Locked, notification.OccurredAtUtc);
                break;
            case SessionChangeReasonKind.SessionUnlock:
                _suppressPolling = false;
                _ = PollAsync();
                break;
            case SessionChangeReasonKind.ConsoleDisconnect:
            case SessionChangeReasonKind.RemoteDisconnect:
                // Paused, not closed: "foreground session continues... without corrupting
                // sessions." Resuming the poll after reconnect naturally either no-ops (same
                // app still foreground) or opens a new session — never a synthetic one.
                _suppressPolling = true;
                break;
            case SessionChangeReasonKind.ConsoleConnect:
            case SessionChangeReasonKind.RemoteConnect:
                _suppressPolling = false;
                _ = PollAsync();
                break;
        }
    }

    private void OnPowerChanged(object? sender, PowerChangeNotification notification)
    {
        switch (notification.Kind)
        {
            case PowerChangeKind.Suspend:
                _suppressPolling = true;
                _ = HandleObservationAsync(AppSessionState.Sleeping, notification.OccurredAtUtc);
                break;
            case PowerChangeKind.ResumeAutomatic:
            case PowerChangeKind.ResumeSuspend:
            case PowerChangeKind.ResumeCritical:
                _suppressPolling = false;
                _ = PollAsync();
                break;
        }
    }

    private void OnIdleStateChanged(object? sender, IdleStateChangeNotification notification)
    {
        if (notification.IsIdle)
        {
            _suppressPolling = true;
            _ = HandleObservationAsync(AppSessionState.Idle, notification.OccurredAtUtc);
        }
        else
        {
            _suppressPolling = false;
            _ = PollAsync();
        }
    }

    private async Task HandleObservationAsync(AppSessionState newState, DateTimeOffset atUtc)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var wasFirstObservation = _tracker.Current is null;
            var transition = _tracker.Observe(newState, atUtc);

            if (transition is null && !wasFirstObservation)
            {
                return;
            }

            if (transition is not null)
            {
                await CloseRowAsync(_currentClientEventId, transition.EndUtc, CancellationToken.None).ConfigureAwait(false);
            }

            await OpenRowAsync(newState, atUtc, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to record app session transition to {Kind}.", newState.Kind);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task CloseCurrentRowIfOpenAsync(DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        var transition = _tracker.Close(atUtc);
        if (transition is not null)
        {
            await CloseRowAsync(_currentClientEventId, atUtc, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task OpenRowAsync(AppSessionState state, DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        var clientEventId = Guid.NewGuid();
        _currentClientEventId = clientEventId;

        var productivityTag = state.Kind == AppSessionKind.Application
            ? ResolveProductivityTag(state.Executable)
            : null;

        var record = new AppSessionRecord
        {
            ClientEventId = clientEventId,
            MachineId = deviceContext.Current.MachineId,
            UserSid = _userSid,
            WindowsSessionId = _windowsSessionId,
            Kind = state.Kind,
            ProcessId = state.ProcessId,
            Executable = state.Executable,
            WindowTitle = state.WindowTitle,
            StartTimeUtc = atUtc,
            ProductivityTag = productivityTag
        };

        await repository.OpenAsync(record, cancellationToken).ConfigureAwait(false);
    }

    private async Task CloseRowAsync(Guid? clientEventId, DateTimeOffset endUtc, CancellationToken cancellationToken)
    {
        if (clientEventId is not { } id)
        {
            return;
        }

        await repository.CloseAsync(id, endUtc, null, cancellationToken).ConfigureAwait(false);
        _currentClientEventId = null;
    }

    private string? ResolveProductivityTag(string executablePath)
    {
        var fileName = Path.GetFileName(executablePath);
        return policyProvider.Current.ProductivityTags.TryGetValue(fileName, out var tag) ? tag : null;
    }
}
