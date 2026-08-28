using Agent.Core.Contracts;
using Agent.Core.Policy;
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
/// local copies only after successful synchronization." That is the whole contract here - rows
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

    /// <summary>
    /// Set while the last cycle hit a transient failure. Drives the exponential backoff below;
    /// cleared as soon as a cycle completes cleanly.
    /// </summary>
    private bool _lastCycleFailed;

    /// <summary>Current backoff delay, grown on consecutive failures and reset on success.</summary>
    private TimeSpan _backoff;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var policy = _state.Policy.Sync;
            _lastCycleFailed = false;

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
                _lastCycleFailed = true;
                _logger.LogWarning(ex, "Sync cycle failed; queued data is retained for the next attempt");
            }

            // Waits out the interval, or returns early when something asks for an immediate sync
            // (the dashboard's force-sync button, relayed over the realtime channel). Waiting on
            // the signal *instead of* sleeping means a nudge shortens this cycle rather than
            // starting a second one alongside it.
            await _state.WaitForSyncRequestAsync(NextDelay(policy), stoppingToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The normal batch interval when things are working, exponential backoff when they are not.
    ///
    /// Backing off matters more than it looks: thirty workstations lose the server at the same
    /// moment and would otherwise retry in lockstep every batch interval for the whole outage,
    /// then all reconnect together. Growing the delay thins that traffic out, and resetting on
    /// the first success means a brief blip costs one slow cycle rather than minutes of silence.
    /// </summary>
    private TimeSpan NextDelay(SyncPolicy policy)
    {
        var min = TimeSpan.FromSeconds(Math.Max(policy.MinRetryBackoffSeconds, 1));
        var max = TimeSpan.FromSeconds(Math.Max(policy.MaxRetryBackoffSeconds, policy.MinRetryBackoffSeconds));

        if (!_lastCycleFailed)
        {
            _backoff = TimeSpan.Zero;
            // Floored at 10s so a misconfigured policy cannot turn the agent into a hot loop.
            return TimeSpan.FromSeconds(Math.Max(policy.BatchIntervalSeconds, 10));
        }

        _backoff = _backoff == TimeSpan.Zero
            ? min
            : TimeSpan.FromSeconds(Math.Min(_backoff.TotalSeconds * 2, max.TotalSeconds));

        _logger.LogDebug("Backing off for {Backoff} before the next sync attempt", _backoff);
        return _backoff;
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

        var result = await _backend.PushEventsAsync(channel, events, ct).ConfigureAwait(false);

        // Marked sent only against ids the server confirmed. Anything else stays queued and is
        // resent verbatim; the server deduplicates on the client event id.
        if (result.Acknowledged.Count > 0)
        {
            _queue.MarkSent(channel, result.Acknowledged);
            _logger.LogInformation("Synced {Acked}/{Total} {Channel} event(s)",
                result.Acknowledged.Count, events.Count, channel);
        }

        // Refused outright: advance the attempt counter so RetentionWorker eventually discards
        // them instead of the queue resending them forever.
        if (result.Rejected.Count > 0)
        {
            _queue.RecordRejection(channel, result.Rejected);
            _logger.LogWarning("Server refused {Count} {Channel} event(s); they will be dropped after repeated attempts",
                result.Rejected.Count, channel);
        }

        if (result.TransientFailure)
        {
            // Do not touch attempt counters - the data is fine, the server is not.
            _lastCycleFailed = true;
            _state.BackendReachable = false;
        }
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
    /// Screenshots upload one at a time rather than as a batch - each is a multipart request
    /// of a megabyte or more, and uploading them serially keeps the agent from saturating an
    /// office uplink after a long offline stretch.
    /// </summary>
    private async Task SyncScreenshotsAsync(int batchSize, CancellationToken ct)
    {
        // Deliberately smaller than the event batch size for the bandwidth reason above.
        var limit = Math.Min(batchSize, 10);

        foreach (var shot in _queue.DequeueScreenshots(limit))
        {
            var outcome = await _backend.UploadScreenshotAsync(
                shot.ClientEventId, shot.UserSid, shot.CapturedAt, shot.FilePath,
                shot.Width, shot.Height, ct).ConfigureAwait(false);

            switch (outcome)
            {
                case UploadOutcome.Delivered:
                    _queue.MarkScreenshotSent(shot.ClientEventId);
                    break;

                case UploadOutcome.Rejected:
                    // The server will refuse these bytes identically every time. Retiring the row
                    // is what stops the retry loop; the retention sweep then deletes the orphaned
                    // JPEG, because Purge collects the file paths of rows it removes.
                    _logger.LogError("Discarding screenshot {Id}: the server refused it outright", shot.ClientEventId);
                    _queue.MarkScreenshotSent(shot.ClientEventId);
                    break;

                case UploadOutcome.Transient:
                    // Server or network is unhappy. Stop the whole set and retry later - pushing
                    // the remaining megabyte-scale uploads at a struggling server helps nobody.
                    _lastCycleFailed = true;
                    _state.BackendReachable = false;
                    return;
            }
        }
    }
}
