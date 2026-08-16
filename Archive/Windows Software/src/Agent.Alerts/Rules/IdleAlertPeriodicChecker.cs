using Agent.Collectors.Activity;
using Agent.Core.Time;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Alerts.Rules;

/// <summary>
/// Idle escalation needs to be re-checked while a session stays open, not just once when it
/// starts - this drives that by periodically re-submitting the currently-open Idle session(s)
/// through the same AlertEngine that event-driven rules use.
/// </summary>
public sealed class IdleAlertPeriodicChecker(
    IActivityRepository activityRepository,
    AlertEngine<ActivitySessionRecord> alertEngine,
    ISystemClock clock,
    ILogger<IdleAlertPeriodicChecker> logger) : IHostedService, IDisposable
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(1);
    private Timer? _timer;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new Timer(_ => _ = CheckAsync(), null, CheckInterval, CheckInterval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private async Task CheckAsync()
    {
        try
        {
            var nowUtc = clock.UtcNow;
            var openSessions = await activityRepository.GetOpenSessionsAsync(CancellationToken.None).ConfigureAwait(false);

            foreach (var session in openSessions.Where(s => s.State == ActivityState.Idle))
            {
                var snapshot = session with { EndTimeUtc = nowUtc };
                await alertEngine.ProcessAsync(snapshot, session.MachineId, session.UserSid, CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Idle alert periodic check failed.");
        }
    }
}
