using Agent.Core;
using Agent.Core.Configuration;
using Agent.Service.Credentials;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SocketIOClient;

namespace Agent.Service.Workers;

/// <summary>
/// Holds the Socket.IO signalling channel to the backend.
///
/// WHAT THIS IS FOR: shortening the gap between an admin doing something in the dashboard and
/// this workstation acting on it. Without it, a policy change waits out the heartbeat interval
/// and a "sync now" button waits out the batch interval.
///
/// WHAT THIS IS EMPHATICALLY NOT: a source of truth about whether the backend is available.
/// Nothing in this file writes <see cref="AgentState.BackendReachable"/>, and that is deliberate.
/// A Socket.IO connection can stay open long after the server has stopped being able to serve
/// writes — the transport survives a database outage, a deploy, a half-open TCP connection that
/// will not surface for minutes — so treating "connected" as "available" would have the agent
/// confidently pushing telemetry at a server that is dropping it. Availability is decided by
/// GET /api/v1/heartbeat in ConnectivityWorker, which proves the credential is accepted *and*
/// that the server reached its database to answer.
///
/// The inverse matters just as much: everything here is optional. If this socket never connects,
/// the agent keeps collecting, keeps syncing on its interval, and keeps picking up policy from
/// the heartbeat. Losing signalling costs promptness and nothing else.
/// </summary>
public sealed class RealtimeWorker(
    AgentState state,
    AgentConfiguration configuration,
    DeviceCredentialStore credentials,
    ILogger<RealtimeWorker> logger) : BackgroundService
{
    private readonly AgentState _state = state;
    private readonly AgentConfiguration _configuration = configuration;
    private readonly DeviceCredentialStore _credentials = credentials;
    private readonly ILogger<RealtimeWorker> _logger = logger;

    /// <summary>Must match AGENT_NAMESPACE in Backend/src/realtime/events.ts.</summary>
    private const string Namespace = "/agents";

    /// <summary>Handshake field carrying the device API key. Must match AGENT_AUTH_FIELD.</summary>
    private const string ApiKeyAuthField = "apiKey";

    // Event names — must match AgentEvent / AgentClientEvent in Backend/src/realtime/events.ts.
    private const string PolicyUpdatedEvent = "policy:updated";
    private const string SyncForceEvent = "sync:force";
    private const string DeviceDeactivatedEvent = "device:deactivated";
    private const string HelloEvent = "agent:hello";

    /// <summary>
    /// How long to wait before checking again when there is nothing to connect with — no
    /// credential yet, or realtime switched off in policy. Short enough to pick up an enrollment
    /// promptly, long enough not to spin.
    /// </summary>
    private static readonly TimeSpan IdlePollInterval = TimeSpan.FromSeconds(30);

    /// <summary>Backoff bounds for connection attempts, mirroring ConnectivityWorker's shape.</summary>
    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var backoff = MinBackoff;

        while (!stoppingToken.IsCancellationRequested)
        {
            // Nothing to authenticate with, or an admin has turned signalling off for the fleet.
            // Either way this is a normal state, not a failure — wait and look again.
            if (!_state.Policy.Realtime.Enabled || !_credentials.HasCredential)
            {
                await DelayAsync(IdlePollInterval, stoppingToken).ConfigureAwait(false);
                continue;
            }

            try
            {
                // The connection is held open by the client's own event loop; this returns when
                // the socket closes for good, at which point the loop rebuilds it.
                await RunConnectionAsync(stoppingToken).ConfigureAwait(false);
                backoff = MinBackoff;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Logged at Debug, not Warning. A workstation that cannot reach the websocket
                // endpoint — a proxy that blocks upgrades, an office firewall — is still fully
                // functional, and logging this at Warning would train operators to ignore the
                // agent log.
                _logger.LogDebug(ex, "Realtime channel unavailable; retrying in {Backoff}", backoff);
            }

            await DelayAsync(backoff, stoppingToken).ConfigureAwait(false);
            backoff = TimeSpan.FromMilliseconds(Math.Min(backoff.TotalMilliseconds * 2, MaxBackoff.TotalMilliseconds));
        }
    }

    private async Task RunConnectionAsync(CancellationToken ct)
    {
        var apiKey = _credentials.Load();
        if (apiKey is null) return;

        var baseUri = new Uri(_configuration.ServerUrl.TrimEnd('/') + Namespace);

        using var client = new SocketIOClient.SocketIO(baseUri, new SocketIOOptions
        {
            Auth = new Dictionary<string, string> { [ApiKeyAuthField] = apiKey },

            // Reconnection is handled by the loop in ExecuteAsync rather than by the library, so
            // that a credential rotated while we were disconnected is re-read on the next attempt
            // instead of the client retrying forever with the old one.
            Reconnection = false,
        });

        // Closed when the socket drops, which is what lets ExecuteAsync fall through to its
        // backoff and rebuild rather than sitting on a dead connection.
        using var disconnected = CancellationTokenSource.CreateLinkedTokenSource(ct);

        client.OnDisconnected += (_, reason) =>
        {
            _logger.LogInformation("Realtime channel closed ({Reason})", reason);
            // ReSharper disable once AccessToDisposedClosure — the handler cannot outlive the
            // using block: DisposeAsync detaches it before the source is disposed.
            if (!disconnected.IsCancellationRequested) disconnected.Cancel();
        };

        // Handlers do no work of their own beyond raising a signal — the workers that own each
        // job pick it up on their own thread. Anything slow here would stall the client's single
        // receive loop and delay every subsequent event.
        client.On(PolicyUpdatedEvent, _ =>
        {
            _logger.LogInformation("Policy change signalled; refreshing");
            _state.RequestPolicyRefresh();
            return Task.CompletedTask;
        });

        client.On(SyncForceEvent, _ =>
        {
            _logger.LogInformation("Immediate sync requested by the server");
            _state.RequestSync();
            return Task.CompletedTask;
        });

        client.On(DeviceDeactivatedEvent, _ =>
        {
            // Advisory only. The authoritative signal is a 403 from the HTTP API, which
            // ConnectivityWorker acts on; this just stops the agent pushing at a server that has
            // already decided to refuse it, a few minutes sooner.
            _logger.LogWarning("Server signalled that this device has been deactivated");
            _state.Deactivated = true;
            return Task.CompletedTask;
        });

        await client.ConnectAsync(ct).ConfigureAwait(false);

        _logger.LogInformation("Realtime channel established");

        await client.EmitAsync(
            HelloEvent,
            [new { agentVersion = DeviceIdentity.GetAgentVersion(), policyVersion = _state.Policy.Version }],
            ct).ConfigureAwait(false);

        // Park until the socket drops or the service stops. No polling: the client's own
        // receive loop drives the handlers above.
        await WaitUntilCancelledAsync(disconnected.Token).ConfigureAwait(false);

        await client.DisconnectAsync().ConfigureAwait(false);
    }

    /// <summary>Awaits cancellation without throwing, so a normal disconnect is not an error path.</summary>
    private static async Task WaitUntilCancelledAsync(CancellationToken token)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var registration = token.Register(() => completion.TrySetResult());
        await completion.Task.ConfigureAwait(false);
    }

    /// <summary>Delay that treats shutdown as an exit condition rather than an exception.</summary>
    private static async Task DelayAsync(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Service is stopping; the caller's loop condition handles it.
        }
    }
}
