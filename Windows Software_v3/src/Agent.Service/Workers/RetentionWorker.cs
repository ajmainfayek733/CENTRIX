using Agent.Core;
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

    /// <summary>
    /// How many outright server rejections an event survives before it is discarded.
    ///
    /// Only rejections count — a transient failure never advances the counter — so this is not a
    /// timeout, it is "the server has told us this specific event is unacceptable this many
    /// times". Five is generous enough to ride out a bad deploy that is rolled back, and small
    /// enough that a genuinely poisoned row stops consuming a sync slot within minutes rather
    /// than sitting in the queue until the retention window expires.
    /// </summary>
    private const int MaxRejectionsBeforeDrop = 5;

    private void Sweep()
    {
        var days = _state.Policy.Retention.UndeliveredRetentionDays;

        // Before the age-based sweep: discard anything the server has repeatedly refused, so it
        // stops being resent every cycle for the rest of the retention window.
        foreach (var (channel, count) in _queue.DropExhausted(MaxRejectionsBeforeDrop))
        {
            _logger.LogError(
                "Dropped {Count} {Channel} event(s) the server refused {Attempts}+ times; this data is lost",
                count, channel, MaxRejectionsBeforeDrop);
        }

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

        SweepLogs();
    }

    /// <summary>
    /// Ages out the rolling log files. The file sink prunes its own history too, but the host
    /// writes as a standard user and is intentionally denied delete rights on the log directory,
    /// so its files can only be removed from here — this service runs as SYSTEM.
    /// </summary>
    private void SweepLogs()
    {
        var cutoff = DateTime.Now.AddDays(-LogRetentionDays);
        var deleted = 0;

        try
        {
            foreach (var path in Directory.EnumerateFiles(AgentPaths.LogDirectory, "*.log"))
            {
                try
                {
                    if (File.GetLastWriteTime(path) >= cutoff) continue;
                    File.Delete(path);
                    deleted++;
                }
                catch (IOException)
                {
                    // Still open by a live host, or being tailed. Next sweep will get it.
                }
            }
        }
        catch (DirectoryNotFoundException)
        {
            // Nothing has logged yet on this machine.
            return;
        }

        if (deleted > 0)
        {
            _logger.LogInformation("Retention sweep removed {Count} log file(s)", deleted);
        }
    }

    /// <summary>
    /// Independent of the telemetry cutoff. Logs are diagnostics, not collected data, so they
    /// are not subject to the policy's privacy-driven retention window — but they still must not
    /// grow without bound.
    /// </summary>
    private const int LogRetentionDays = 14;
}
