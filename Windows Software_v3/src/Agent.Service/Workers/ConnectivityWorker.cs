using Agent.Core.Storage;
using Agent.Service.Backend;
using Agent.Service.Credentials;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Workers;

/// <summary>
/// Owns the agent's relationship with the backend: enrollment, the heartbeat gate, and policy
/// refresh. Features.md "Device Auth" requires the agent to pass a heartbeat before it starts
/// syncing, and to retry enrollment indefinitely with backoff if the server is unreachable —
/// without ever interrupting local data collection.
///
/// Enrollment, heartbeat and policy live in one worker rather than three because they are
/// strictly ordered: there is no point fetching policy with a credential that has not been
/// proven, and no point proving a credential that has not been issued.
/// </summary>
public sealed class ConnectivityWorker(
    AgentState state,
    BackendClient backend,
    DeviceCredentialStore credentials,
    LocalStore store,
    ILogger<ConnectivityWorker> logger) : BackgroundService
{
    private readonly AgentState _state = state;
    private readonly BackendClient _backend = backend;
    private readonly DeviceCredentialStore _credentials = credentials;
    private readonly LocalStore _store = store;
    private readonly ILogger<ConnectivityWorker> _logger = logger;

    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);

    /// <summary>How often to re-check policy once the agent is connected and healthy.</summary>
    private static readonly TimeSpan PolicyRefreshInterval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Warm the in-memory policy from the local cache before touching the network, so a
        // workstation that boots offline still collects against the last known configuration
        // rather than the compiled-in defaults.
        var cached = _store.LoadPolicy();
        if (cached is not null)
        {
            _state.ApplyPolicy(cached);
            _logger.LogInformation("Loaded cached policy v{Version}", cached.Version);
        }

        var backoff = MinBackoff;

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var healthy = await RunCycleAsync(stoppingToken).ConfigureAwait(false);

                if (healthy)
                {
                    backoff = MinBackoff;
                    await Task.Delay(PolicyRefreshInterval, stoppingToken).ConfigureAwait(false);
                    continue;
                }
            }
            catch (DeviceDeactivatedException ex)
            {
                // An admin switched this device off. Stop talking to the server, but keep
                // collecting locally: reactivating should not leave a gap in the record.
                _logger.LogWarning(ex, "Device is deactivated; pausing backend traffic and continuing local collection");
                _state.Deactivated = true;
                _state.BackendReachable = false;
                await Task.Delay(TimeSpan.FromMinutes(15), stoppingToken).ConfigureAwait(false);
                continue;
            }
            catch (DeviceUnauthorizedException ex)
            {
                // The stored key is no longer valid — most often because the workstation was
                // re-imaged or the device row was deleted. Drop it and let the next cycle
                // re-enroll from the install-time token.
                _logger.LogWarning(ex, "Device credential rejected; discarding it and re-enrolling");
                _credentials.Clear();
                _state.Enrolled = false;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Backend cycle failed; retrying in {Backoff}", backoff);
            }

            _state.BackendReachable = false;
            await Task.Delay(backoff, stoppingToken).ConfigureAwait(false);

            // Exponential backoff, capped. Collection is unaffected while this loops, so a
            // long outage costs nothing but a delayed upload.
            backoff = TimeSpan.FromMilliseconds(Math.Min(backoff.TotalMilliseconds * 2, MaxBackoff.TotalMilliseconds));
        }
    }

    /// <summary>Returns true when the agent is enrolled, heartbeating, and holding fresh policy.</summary>
    private async Task<bool> RunCycleAsync(CancellationToken ct)
    {
        if (!_credentials.HasCredential)
        {
            _logger.LogInformation("No device credential stored; enrolling");
            if (!await _backend.EnrollAsync(ct).ConfigureAwait(false)) return false;
        }

        var heartbeat = await _backend.HeartbeatAsync(ct).ConfigureAwait(false);
        if (heartbeat is null || !heartbeat.Authenticated) return false;

        _state.Enrolled = true;
        _state.Deactivated = false;
        _state.BackendReachable = true;

        // Only pull the full document when the version actually moved. The heartbeat is cheap
        // and runs every few minutes; the policy document is not.
        if (heartbeat.PolicyVersion != _state.Policy.Version)
        {
            var policy = await _backend.GetPolicyAsync(ct).ConfigureAwait(false);
            if (policy is not null)
            {
                _store.SavePolicy(policy);
                var versionChanged = _state.ApplyPolicy(policy);
                _logger.LogInformation(
                    "Applied policy v{Version}{Consent}",
                    policy.Version,
                    versionChanged ? " (employee re-acknowledgement required)" : string.Empty);
            }
        }

        return true;
    }
}
