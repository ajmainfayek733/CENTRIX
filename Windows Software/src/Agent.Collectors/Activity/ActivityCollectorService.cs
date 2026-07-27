using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Input;
using Agent.Native.Sessions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Activity;

/// <summary>
/// The real Active/Idle/Locked/Sleeping/Offline authority for the whole agent. Also implements
/// <see cref="IIdleStateSource"/> so Attendance and App Session consume this richer,
/// policy-aware signal directly instead of a bare idle-threshold poll — this is the
/// implementation that resolves the interim gap flagged when those two modules were built.
/// </summary>
/// <remarks>
/// Idle-duration polling (GetLastInputInfo) and foreground-window polling only work in an
/// interactive session, so this runs in the per-user tray helper, writing directly to the same
/// encrypted database the service uses.
/// </remarks>
public sealed class ActivityCollectorService(
    IIdleInputMonitor idleInputMonitor,
    IForegroundWindowMonitor foregroundWindowMonitor,
    ICpuUsageMonitor cpuUsageMonitor,
    ISessionEventSource sessionEvents,
    IPowerEventSource powerEvents,
    ICurrentUserProvider currentUserProvider,
    IDeviceContextProvider deviceContext,
    IActivityRepository repository,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<ActivityCollectorService> logger) : IHostedService, IIdleStateSource, IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    private readonly ActivitySessionTracker _tracker = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Timer? _pollTimer;
    private Guid? _currentClientEventId;
    private readonly string _userSid = currentUserProvider.GetCurrentUserSid();
    private volatile bool _isLocked;
    private volatile bool _isSleeping;
    private volatile bool _isOffline = true;

    private string? _lastForegroundExecutable;
    private DateTimeOffset _foregroundSinceUtc;

    public event EventHandler<IdleStateChangeNotification>? IdleStateChanged;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged += OnSessionChanged;
        powerEvents.PowerChanged += OnPowerChanged;
        _pollTimer = new Timer(_ => _ = TickAsync(), null, PollInterval, PollInterval);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        sessionEvents.SessionChanged -= OnSessionChanged;
        powerEvents.PowerChanged -= OnPowerChanged;
        _pollTimer?.Dispose();

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var transition = _tracker.Close(clock.UtcNow);
            if (transition is not null)
            {
                await CloseRowAsync(clock.UtcNow, cancellationToken).ConfigureAwait(false);
            }
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

    private void OnSessionChanged(object? sender, SessionChangeNotification notification)
    {
        switch (notification.Reason)
        {
            case SessionChangeReasonKind.SessionLock:
                _isLocked = true;
                break;
            case SessionChangeReasonKind.SessionUnlock:
                _isLocked = false;
                break;
            case SessionChangeReasonKind.SessionLogon:
                _isOffline = false;
                break;
            case SessionChangeReasonKind.SessionLogoff:
                _isOffline = true;
                break;
        }
    }

    private void OnPowerChanged(object? sender, PowerChangeNotification notification)
    {
        switch (notification.Kind)
        {
            case PowerChangeKind.Suspend:
                _isSleeping = true;
                break;
            case PowerChangeKind.ResumeAutomatic:
            case PowerChangeKind.ResumeSuspend:
            case PowerChangeKind.ResumeCritical:
                _isSleeping = false;
                break;
        }
    }

    private async Task TickAsync()
    {
        if (!policyProvider.Current.Activity.Enabled)
        {
            return;
        }

        var nowUtc = clock.UtcNow;
        var foreground = foregroundWindowMonitor.GetCurrentForegroundWindow();
        UpdateForegroundContinuity(foreground?.ExecutablePath, nowUtc);

        var signal = new ActivitySignal
        {
            AtUtc = nowUtc,
            IdleInputDuration = idleInputMonitor.GetIdleDuration(),
            IsSessionLocked = _isLocked,
            IsSleeping = _isSleeping,
            IsOffline = _isOffline,
            ForegroundExecutable = foreground?.ExecutablePath,
            ForegroundContinuousDuration = nowUtc - _foregroundSinceUtc,
            CpuUsagePercent = cpuUsageMonitor.GetTotalProcessorUsagePercent()
        };

        var evaluation = ActivityDecisionEngine.Evaluate(signal, policyProvider.Current.Activity);
        await ApplyEvaluationAsync(evaluation, nowUtc).ConfigureAwait(false);
    }

    private void UpdateForegroundContinuity(string? executable, DateTimeOffset nowUtc)
    {
        if (!string.Equals(executable, _lastForegroundExecutable, StringComparison.OrdinalIgnoreCase))
        {
            _lastForegroundExecutable = executable;
            _foregroundSinceUtc = nowUtc;
        }
    }

    private async Task ApplyEvaluationAsync(ActivityEvaluation evaluation, DateTimeOffset atUtc)
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var previousState = _tracker.Current?.Evaluation.State;
            var wasFirstObservation = _tracker.Current is null;
            var transition = _tracker.Observe(evaluation, atUtc);

            if (transition is null && !wasFirstObservation)
            {
                return;
            }

            if (transition is not null)
            {
                await CloseRowAsync(transition.EndUtc, CancellationToken.None).ConfigureAwait(false);
            }

            await OpenRowAsync(evaluation, atUtc, CancellationToken.None).ConfigureAwait(false);

            RaiseIdleTransitionIfNeeded(previousState, evaluation.State, atUtc);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to record activity transition to {State}.", evaluation.State);
        }
        finally
        {
            _gate.Release();
        }
    }

    private void RaiseIdleTransitionIfNeeded(ActivityState? previousState, ActivityState newState, DateTimeOffset atUtc)
    {
        var wasIdle = previousState == ActivityState.Idle;
        var isIdle = newState == ActivityState.Idle;
        if (wasIdle != isIdle)
        {
            IdleStateChanged?.Invoke(this, new IdleStateChangeNotification(isIdle, atUtc));
        }
    }

    private async Task OpenRowAsync(ActivityEvaluation evaluation, DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        var clientEventId = Guid.NewGuid();
        _currentClientEventId = clientEventId;

        var record = new ActivitySessionRecord
        {
            ClientEventId = clientEventId,
            MachineId = deviceContext.Current.MachineId,
            UserSid = _userSid,
            State = evaluation.State,
            Reason = evaluation.Reason,
            StartTimeUtc = atUtc
        };

        await repository.OpenAsync(record, cancellationToken).ConfigureAwait(false);
    }

    private async Task CloseRowAsync(DateTimeOffset endUtc, CancellationToken cancellationToken)
    {
        if (_currentClientEventId is not { } id)
        {
            return;
        }

        await repository.CloseAsync(id, endUtc, cancellationToken).ConfigureAwait(false);
        _currentClientEventId = null;
    }
}
