using Agent.Core.Storage;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Workers;

/// <summary>
/// Sweeps synced rows off disk and drops undelivered ones that have aged out.
///
/// Two requirements meet here. Features.md wants local copies deleted only after successful
/// synchronization, which is why this only removes rows already marked sent. Spec section 3.1
/// wants configurable auto-deletion so an agent that never reaches its server cannot grow
/// without bound, which is the UndeliveredRetentionDays cutoff.
/// </summary>
public sealed class RetentionWorker(
    AgentState state,
    TelemetryQueue queue,
    ILogger<RetentionWorker> logger) : BackgroundService
{
    private readonly AgentState _state = state;
    private readonly TelemetryQueue _queue = queue;
    private readonly ILogger<RetentionWorker> _logger = logger;

    /// <summary>
    /// Hourly. The cutoff is measured in days, so sweeping more often would only add wakeups;
    /// sweeping less often risks a burst of disk use on a busy machine between passes.
    /// </summary>
    private static readonly TimeSpan SweepInterval = TimeSpan.FromHours(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Close out any attendance session left open by an unclean shutdown before the first
        // sweep, so the recovered row is uploaded rather than swept as stale.
        try
        {
            _queue.RecoverOpenAttendanceSessions();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not recover open attendance sessions at startup");
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                Sweep();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Retention sweep failed");
            }

            await Task.Delay(SweepInterval, stoppingToken).ConfigureAwait(false);
        }
    }

    private void Sweep()
    {
        var days = _state.Policy.Retention.UndeliveredRetentionDays;
        var orphanedFiles = _queue.Purge(days);

        var deleted = 0;
        foreach (var path in orphanedFiles)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                    deleted++;
                }
            }
            catch (IOException ex)
            {
                // A screenshot still held open by the uploader will be caught next sweep.
                _logger.LogDebug(ex, "Could not delete screenshot {Path}", path);
            }
        }

        if (deleted > 0)
        {
            _logger.LogInformation("Retention sweep removed {Count} screenshot file(s)", deleted);
        }
    }
}
