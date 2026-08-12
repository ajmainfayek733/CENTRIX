using System.Runtime.Versioning;
using Agent.Core.Time;

namespace Agent.Native.Input;

/// <summary>
/// Polls <see cref="IIdleInputMonitor"/> (GetLastInputInfo) at a fixed interval and raises a
/// transition only when crossing the idle threshold, per the Active/Idle spec's "store
/// transitions, not every tick" guidance. Must run in the interactive user session - a Session
/// 0 Windows Service has no meaningful GetLastInputInfo signal (Microsoft Learn: Session 0
/// Isolation) - so this is intended to be hosted by the per-user tray helper, which relays
/// transitions to the service over IPC.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class PollingIdleStateSource : IIdleStateSource, IDisposable
{
    private readonly IIdleInputMonitor _idleInputMonitor;
    private readonly ISystemClock _clock;
    private readonly PeriodicTimer _timer;
    private readonly CancellationTokenSource _cts = new();
    private bool _isIdle;

    public PollingIdleStateSource(
        IIdleInputMonitor idleInputMonitor,
        ISystemClock clock,
        TimeSpan idleThreshold,
        TimeSpan? pollInterval = null)
    {
        _idleInputMonitor = idleInputMonitor;
        _clock = clock;
        IdleThreshold = idleThreshold;
        _timer = new PeriodicTimer(pollInterval ?? TimeSpan.FromSeconds(1));
        _ = Task.Run(() => PollLoopAsync(_cts.Token));
    }

    public TimeSpan IdleThreshold { get; set; }

    public event EventHandler<IdleStateChangeNotification>? IdleStateChanged;

    public void Dispose()
    {
        _cts.Cancel();
        _timer.Dispose();
        _cts.Dispose();
    }

    private async Task PollLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (await _timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
            {
                var isIdleNow = _idleInputMonitor.GetIdleDuration() >= IdleThreshold;
                if (isIdleNow == _isIdle)
                {
                    continue;
                }

                _isIdle = isIdleNow;
                IdleStateChanged?.Invoke(this, new IdleStateChangeNotification(isIdleNow, _clock.UtcNow));
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
