using Agent.Alerts;
using Agent.Core.Policy;
using Agent.Core.Time;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.TrayHelper;

/// <summary>
/// The single place any alert — regardless of which process (service or tray helper) created it
/// — actually gets shown to the user, since only this process can display UI in the
/// interactive session.
/// </summary>
public sealed class PendingAlertNotificationPoller(
    IAlertRepository repository,
    IAlertNotifier notifier,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<PendingAlertNotificationPoller> logger) : IHostedService, IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private System.Threading.Timer? _timer;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new System.Threading.Timer(_ => _ = PollAsync(), null, PollInterval, PollInterval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private async Task PollAsync()
    {
        try
        {
            var nowUtc = clock.UtcNow;
            var renotifyInterval = policyProvider.Current.Alert.Idle.RenotifyInterval;
            var due = await repository.GetDueForNotificationAsync(nowUtc, renotifyInterval, CancellationToken.None).ConfigureAwait(false);

            foreach (var alert in due)
            {
                var displayed = await notifier.NotifyAsync(alert, CancellationToken.None).ConfigureAwait(false);
                if (displayed)
                {
                    await repository.RecordNotificationAsync(alert.ClientEventId, nowUtc, CancellationToken.None).ConfigureAwait(false);
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Pending alert notification poll failed.");
        }
    }
}
