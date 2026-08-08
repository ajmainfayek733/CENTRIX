using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Agent.Core;
using Agent.Core.Ipc;
using Agent.Core.Storage;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Ipc;

/// <summary>
/// Named-pipe server the per-user host connects to.
///
/// Security: the pipe ACL grants full control to SYSTEM and Administrators and read/write to
/// authenticated interactive users — the host runs as the logged-on employee, so it cannot be
/// restricted to elevated callers. That means a determined user could in principle connect and
/// submit fabricated events. The mitigation is scope rather than secrecy: nothing on this pipe
/// can change policy, disable collection, or reach the backend credential, so the worst case is
/// noise in that user's own telemetry. Anonymous and network access are denied outright.
/// </summary>
public sealed class IpcServer(
    AgentState state,
    TelemetryQueue queue,
    LocalStore store,
    ILogger<IpcServer> logger) : BackgroundService
{
    private readonly AgentState _state = state;
    private readonly TelemetryQueue _queue = queue;
    private readonly LocalStore _store = store;
    private readonly ILogger<IpcServer> _logger = logger;

    /// <summary>
    /// Live host connections, keyed by an id we mint per connection. Normally there is exactly
    /// one, but fast-user-switching can briefly leave two sessions with a host running.
    /// </summary>
    private readonly ConcurrentDictionary<Guid, NamedPipeServerStream> _connections = new();

    /// <summary>
    /// More instances than sessions we ever expect, so a leaked handle cannot lock out a
    /// legitimate host.
    /// </summary>
    private const int MaxServerInstances = 8;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _state.PolicyChanged += OnPolicyChanged;

        try
        {
            // One accept loop per allowed instance, so several sessions can be served at once.
            var listeners = Enumerable
                .Range(0, 4)
                .Select(_ => AcceptLoopAsync(stoppingToken))
                .ToArray();

            await Task.WhenAll(listeners).ConfigureAwait(false);
        }
        finally
        {
            _state.PolicyChanged -= OnPolicyChanged;
        }
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            var connectionId = Guid.NewGuid();

            try
            {
                pipe = CreatePipe();
                await pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);

                _connections[connectionId] = pipe;
                _logger.LogInformation("Host connected ({ConnectionId})", connectionId);

                await ServeAsync(pipe, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "IPC connection {ConnectionId} faulted", connectionId);

                // Back off briefly so a repeatable failure (for example an ACL problem) does
                // not spin the CPU reopening the pipe thousands of times a second.
                await Task.Delay(TimeSpan.FromSeconds(2), ct).ConfigureAwait(false);
            }
            finally
            {
                _connections.TryRemove(connectionId, out _);
                pipe?.Dispose();
            }
        }
    }

    private static NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();

        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        // The host runs as the logged-on employee, who is an ordinary user on a managed
        // workstation, so it needs read/write here. ReadWrite excludes ChangePermissions and
        // TakeOwnership, so a user cannot re-ACL the pipe.
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow));

        // Anonymous callers are denied even where an inherited rule might otherwise allow them.
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AnonymousSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Deny));

        return NamedPipeServerStreamAcl.Create(
            AgentPaths.IpcPipeName,
            PipeDirection.InOut,
            MaxServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            inBufferSize: 64 * 1024,
            outBufferSize: 64 * 1024,
            security);
    }

    private async Task ServeAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        while (pipe.IsConnected && !ct.IsCancellationRequested)
        {
            var message = await IpcChannel.ReadMessageAsync(pipe, ct).ConfigureAwait(false);
            if (message is null) break;

            var reply = Handle(message);
            if (reply is not null)
            {
                await IpcChannel.WriteMessageAsync(pipe, reply, ct).ConfigureAwait(false);
            }
        }
    }

    private IpcMessage? Handle(IpcMessage message)
    {
        switch (message)
        {
            case HelloMessage hello:
                _state.ActiveUserSid = hello.UserSid;
                _logger.LogInformation(
                    "Host v{Version} attached for session {Session} (sid {Sid})",
                    hello.HostVersion, hello.WindowsSessionId, hello.UserSid);

                return new HelloAckMessage
                {
                    Policy = _state.Policy,
                    ConsentRequired = !_store.HasConsented(hello.UserSid, _state.Policy.Version),
                    BackendReachable = _state.BackendReachable
                };

            case SubmitAttendanceMessage m:
                _queue.Enqueue(m.Event);
                return null;

            case SubmitActivityMetricMessage m:
                _queue.Enqueue(m.Event);
                return null;

            case SubmitActivitySessionMessage m:
                _queue.Enqueue(m.Event);
                return null;

            case SubmitBrowserActivityMessage m:
                _queue.Enqueue(m.Event);
                return null;

            case SubmitAlertMessage m:
                _queue.Enqueue(m.Event);
                return null;

            case SubmitScreenshotMessage m:
                _queue.EnqueueScreenshot(
                    m.ClientEventId, m.UserSid, m.CapturedAt, m.FilePath, m.SizeBytes, m.Width, m.Height);
                return null;

            case ConsentAcknowledgedMessage m:
                _store.RecordConsent(m.UserSid, m.PolicyVersion, m.AcknowledgedAt);
                _logger.LogInformation("Consent recorded for policy v{Version}", m.PolicyVersion);
                return null;

            case PingMessage:
                return new PingMessage();

            default:
                _logger.LogWarning("Ignoring unexpected IPC message {Type}", message.GetType().Name);
                return null;
        }
    }

    private void OnPolicyChanged(Agent.Core.Policy.AgentPolicy policy, bool consentRequired)
    {
        var notification = new PolicyUpdatedMessage { Policy = policy, ConsentRequired = consentRequired };
        _ = BroadcastAsync(notification);
    }

    /// <summary>
    /// Pushes a message to every connected host. Failures are logged and swallowed: a host
    /// that died between the connection check and the write must not take down the service.
    /// </summary>
    public async Task BroadcastAsync(IpcMessage message, CancellationToken ct = default)
    {
        foreach (var (id, pipe) in _connections)
        {
            try
            {
                if (!pipe.IsConnected) continue;
                await IpcChannel.WriteMessageAsync(pipe, message, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Could not deliver {Type} to host {ConnectionId}", message.GetType().Name, id);
            }
        }
    }

    public bool HasConnectedHost => _connections.Values.Any(p => p.IsConnected);
}
