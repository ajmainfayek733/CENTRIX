using Agent.Core.Contracts;
using Agent.Core.Storage;
using Agent.Service.Backend;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Workers;

/// <summary>
/// Drains the local queue to the backend.
///
/// Features.md: "If backend synchronization is unavailable, the agent securely stores data
/// locally and automatically uploads pending records when connectivity is restored, deleting
/// local copies only after successful synchronization." That is the whole contract here — rows
/// are marked sent only against ids the server explicitly acknowledged, and the retention sweep
/// is what finally removes them from disk.
/// </summary>
public sealed class SyncWorker(
    AgentState state,
    TelemetryQueue queue,
    BackendClient backend,
    ILogger<SyncWorker> logger) : BackgroundService
{
    private readonly AgentState _state = state;
    private readonly TelemetryQueue _queue = queue;
    private readonly BackendClient _backend = backend;
    private readonly ILogger<SyncWorker> _logger = logger;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var policy = _state.Policy.Sync;
            var interval = TimeSpan.FromSeconds(Math.Max(policy.BatchIntervalSeconds, 10));

            try
            {
                // Nothing to do until the device is enrolled and not switched off by an admin.
                // Collection keeps running regardless; only the upload waits.
                if (_state is { Enrolled: true, Deactivated: false, BackendReachable: true })
                {
                    await SyncOnceAsync(policy.MaxBatchSize, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (DeviceDeactivatedException)
            {
                _state.Deactivated = true;
                _logger.LogWarning("Sync halted: device deactivated by an administrator");
            }
            catch (DeviceUnauthorizedException)
            {
                // ConnectivityWorker owns re-enrollment; just stop pushing until it recovers.
                _state.Enrolled = false;
                _logger.LogWarning("Sync halted: device credential rejected, awaiting re-enrollment");
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _state.BackendReachable = false;
                _logger.LogWarning(ex, "Sync cycle failed; queued data is retained for the next attempt");
            }

            await Task.Delay(interval, stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task SyncOnceAsync(int batchSize, CancellationToken ct)
    {
        // Ordered deliberately. Attendance and activity sessions carry the session and
        // activity-session ids that browser visits and USB events reference as foreign keys;
        // sending parents first means the server can resolve those links instead of nulling
        // them and losing the association.
        await PushAsync(TelemetryChannel.Attendance, _queue.DequeueAttendance(batchSize), ct).ConfigureAwait(false);
        await PushAsync(TelemetryChannel.ActivitySession, _queue.DequeueActivitySessions(batchSize), ct).ConfigureAwait(false);
        await PushAsync(TelemetryChannel.BrowserActivity, _queue.DequeueBrowserActivity(batchSize), ct).ConfigureAwait(false);
        await PushAsync(TelemetryChannel.ActivityMetric, _queue.DequeueActivityMetrics(batchSize), ct).ConfigureAwait(false);
        await PushAsync(TelemetryChannel.UsbEvent, _queue.DequeueUsbEvents(batchSize), ct).ConfigureAwait(false);
        await PushAsync(TelemetryChannel.Alert, _queue.DequeueAlerts(batchSize), ct).ConfigureAwait(false);

        await SyncConsentsAsync(batchSize, ct).ConfigureAwait(false);
        await SyncScreenshotsAsync(batchSize, ct).ConfigureAwait(false);
    }

    private async Task PushAsync<T>(TelemetryChannel channel, List<T> events, CancellationToken ct)
        where T : ITelemetryEvent
    {
        if (events.Count == 0) return;

        var acknowledged = await _backend.PushEventsAsync(channel, events, ct).ConfigureAwait(false);

        if (acknowledged.Count == 0)
        {
            _queue.RecordFailure(channel, events.Count);
            return;
        }

        _queue.MarkSent(channel, acknowledged);
        _logger.LogInformation("Synced {Acked}/{Total} {Channel} event(s)", acknowledged.Count, events.Count, channel);
    }

    private async Task SyncConsentsAsync(int batchSize, CancellationToken ct)
    {
        foreach (var consent in _queue.DequeueConsents(batchSize))
        {
            var ok = await _backend
                .PostConsentAsync(consent.UserSid, consent.PolicyVersion, consent.AcknowledgedAt, ct)
                .ConfigureAwait(false);

            if (ok) _queue.MarkConsentSent(consent.UserSid, consent.PolicyVersion);
        }
    }

    /// <summary>
    /// Screenshots upload one at a time rather than as a batch — each is a multipart request
    /// of a megabyte or more, and uploading them serially keeps the agent from saturating an
    /// office uplink after a long offline stretch.
    /// </summary>
    private async Task SyncScreenshotsAsync(int batchSize, CancellationToken ct)
    {
        // Deliberately smaller than the event batch size for the bandwidth reason above.
        var limit = Math.Min(batchSize, 10);

        foreach (var shot in _queue.DequeueScreenshots(limit))
        {
            var ok = await _backend.UploadScreenshotAsync(
                shot.ClientEventId, shot.UserSid, shot.CapturedAt, shot.FilePath,
                shot.Width, shot.Height, ct).ConfigureAwait(false);

            if (!ok) break; // Server or network is unhappy; stop and retry the whole set later.

            _queue.MarkScreenshotSent(shot.ClientEventId);
        }
    }
}
