using Agent.Core.Consent;
using Agent.Core.Policy;
using Agent.Core.Sync;
using Agent.Core.Time;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Sync;

/// <summary>
/// The only component that talks to the backend. Reads the shared outbox - every module writes
/// there in the same local transaction as its own domain write - batches per channel, and
/// applies exponential backoff while the backend is unreachable. Immediate-priority channels
/// (alerts, USB) are checked far more often than the batched interval; batched channels wait
/// for the full interval so most modules don't chatter over the wire. Nothing is transmitted
/// until <see cref="ConsentGate"/> reports the device's monitoring notice has been acknowledged
/// (see ConsentGateHostedService) - data still buffers locally in the outbox in the meantime.
/// </summary>
public sealed class SyncWorker(
    IOutboxRepository outbox,
    IBackendClient backendClient,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ConsentGate consentGate,
    ILogger<SyncWorker> logger) : IHostedService, IDisposable
{
    private static readonly TimeSpan ImmediateCheckInterval = TimeSpan.FromSeconds(5);

    private Timer? _batchedTimer;
    private Timer? _immediateTimer;
    private TimeSpan _currentBackoff;
    private DateTimeOffset _nextAttemptAllowedAtUtc = DateTimeOffset.MinValue;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _currentBackoff = policyProvider.Current.Sync.MinRetryBackoff;
        var batchInterval = policyProvider.Current.Sync.BatchInterval;

        _batchedTimer = new Timer(_ => _ = RunCycleAsync(SyncPriority.Batched), null, batchInterval, batchInterval);
        _immediateTimer = new Timer(_ => _ = RunCycleAsync(SyncPriority.Immediate), null, ImmediateCheckInterval, ImmediateCheckInterval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _batchedTimer?.Dispose();
        _immediateTimer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _batchedTimer?.Dispose();
        _immediateTimer?.Dispose();
    }

    private async Task RunCycleAsync(SyncPriority priorityFilter)
    {
        if (!consentGate.IsAcknowledged)
        {
            return;
        }

        if (clock.UtcNow < _nextAttemptAllowedAtUtc)
        {
            // Backing off after a prior failure - the batched/immediate timers keep ticking on
            // their fixed cadence, but actual backend calls are suppressed until the backoff
            // window elapses.
            return;
        }

        try
        {
            var policy = policyProvider.Current.Sync;
            var channels = await outbox.GetPendingChannelsAsync(CancellationToken.None).ConfigureAwait(false);
            var anyFailure = false;
            var anyWork = false;

            foreach (var channel in channels)
            {
                var batch = await outbox.GetPendingAsync(channel, policy.MaxBatchSize, CancellationToken.None).ConfigureAwait(false);
                var filtered = batch.Where(record => record.Priority == priorityFilter).ToList();
                if (filtered.Count == 0)
                {
                    continue;
                }

                anyWork = true;
                var payloads = filtered.Select(r => new OutboxPayload(r.ClientEventId, r.PayloadJson)).ToList();
                var result = await backendClient.PushEventsAsync(channel, payloads, CancellationToken.None).ConfigureAwait(false);

                if (result.Success)
                {
                    await outbox.MarkSyncedAsync(result.AcknowledgedEventIds, CancellationToken.None).ConfigureAwait(false);
                }
                else
                {
                    anyFailure = true;
                    await outbox.IncrementAttemptsAsync(filtered.Select(r => r.ClientEventId).ToList(), CancellationToken.None).ConfigureAwait(false);
                    logger.LogWarning("Sync push failed for channel {Channel}: {Error}", channel, result.Error);
                }
            }

            if (anyWork)
            {
                UpdateBackoff(succeeded: !anyFailure, policy);
            }

            await outbox.PurgeExpiredUnsyncedAsync(
                TimeSpan.FromDays(policyProvider.Current.Retention.UndeliveredRetentionDays),
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Sync cycle failed unexpectedly.");
        }
    }

    private void UpdateBackoff(bool succeeded, SyncPolicy policy)
    {
        if (succeeded)
        {
            _currentBackoff = policy.MinRetryBackoff;
            _nextAttemptAllowedAtUtc = DateTimeOffset.MinValue;
            return;
        }

        _currentBackoff = TimeSpan.FromMilliseconds(Math.Min(_currentBackoff.TotalMilliseconds * 2, policy.MaxRetryBackoff.TotalMilliseconds));
        _nextAttemptAllowedAtUtc = clock.UtcNow + _currentBackoff;
    }
}
