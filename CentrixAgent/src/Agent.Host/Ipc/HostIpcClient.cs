using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using Agent.Core;
using Agent.Core.Ipc;
using Agent.Core.Policy;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Ipc;

/// <summary>
/// The host's connection to the service.
///
/// Observations move here first; they are persisted locally if the service pipe is unavailable so
/// a brief disconnect does not silently lose a boundary or browser segment. The service still owns
/// the durable backend store and upload queue; this is only the per-host replay buffer.
/// </summary>
public sealed class HostIpcClient(ILogger<HostIpcClient> logger) : IAsyncDisposable
{
    private readonly ILogger<HostIpcClient> _logger = logger;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly HostMessageQueue _pendingMessages = new();

    private NamedPipeClientStream? _pipe;
    private CancellationTokenSource? _readerCts;

    public bool IsConnected => _pipe?.IsConnected == true;
    public int PendingMessageCount => _pendingMessages.PendingCount;

    /// <summary>Latest policy pushed by the service. Starts at Features.md defaults.</summary>
    public AgentPolicy Policy { get; private set; } = new();

    public event Action<AgentPolicy, bool>? PolicyUpdated;
    public event Action<ShowNotificationMessage>? NotificationRequested;
    public event Action? ScreenshotRequested;
    public event Action<bool>? ConnectionStateChanged;

    public async Task<bool> ConnectAsync(CancellationToken ct)
    {
        try
        {
            var pipe = new NamedPipeClientStream(
                ".",
                AgentPaths.IpcPipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous,
                // Stated rather than left to the default, which is already None.
                //
                // A named pipe server can call ImpersonateNamedPipeClient and execute as whoever
                // connected to it. This client runs as the logged-on employee and connects to a
                // well-known name, so a local process that managed to own that name first could
                // impersonate them. None is the documented defence, and writing it here means a
                // later edit to this constructor cannot quietly grant impersonation by picking a
                // different overload.
                TokenImpersonationLevel.None);

            // Short timeout: the caller retries on a schedule, and a long block here would
            // delay the collectors starting when the service is simply not up yet.
            await pipe.ConnectAsync(3000, ct).ConfigureAwait(false);

            _pipe = pipe;

            var identity = WindowsIdentity.GetCurrent();
            await SendAsync(new HelloMessage
            {
                UserSid = identity.User?.Value ?? "S-1-0-0",
                UserName = identity.Name,
                // The terminal-services session, not the pid. The service logs this to tell
                // concurrent hosts apart during fast user switching, which a process id cannot
                // do - and it is the same id the host's log file is named after.
                WindowsSessionId = Process.GetCurrentProcess().SessionId,
                HostVersion = DeviceIdentity.GetAgentVersion()
            }, ct).ConfigureAwait(false);

            _readerCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _ = Task.Run(() => ReadLoopAsync(_readerCts.Token), _readerCts.Token);

            await FlushPendingMessagesAsync(ct).ConfigureAwait(false);

            ConnectionStateChanged?.Invoke(true);
            _logger.LogInformation("Connected to the agent service");
            return true;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "Agent service is not accepting connections yet");
            return false;
        }
    }

    private async Task ReadLoopAsync(CancellationToken ct)
    {
        try
        {
            while (_pipe is { IsConnected: true } && !ct.IsCancellationRequested)
            {
                var message = await IpcChannel.ReadMessageAsync(_pipe, ct).ConfigureAwait(false);
                if (message is null) break;

                switch (message)
                {
                    case HelloAckMessage ack:
                        Policy = ack.Policy;
                        PolicyUpdated?.Invoke(ack.Policy, ack.ConsentRequired);
                        break;

                    case PolicyUpdatedMessage update:
                        Policy = update.Policy;
                        _logger.LogInformation("Policy v{Version} received from the service", update.Policy.Version);
                        PolicyUpdated?.Invoke(update.Policy, update.ConsentRequired);
                        break;

                    case ShowNotificationMessage notification:
                        NotificationRequested?.Invoke(notification);
                        break;

                    case RequestScreenshotMessage:
                        ScreenshotRequested?.Invoke();
                        break;

                    case ShutdownMessage shutdown:
                        _logger.LogInformation("Service asked the host to stop: {Reason}", shutdown.Reason ?? "no reason given");
                        Environment.Exit(0);
                        break;
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "IPC read loop ended");
        }
        finally
        {
            ConnectionStateChanged?.Invoke(false);
        }
    }

    /// <summary>
    /// Sends one message. Serialized behind a lock because collectors run on several timers
    /// and two concurrent writes would interleave their length-prefixed frames.
    /// </summary>
    public async Task<bool> SendAsync(IpcMessage message, CancellationToken ct = default)
    {
        if (_pipe is not { IsConnected: true })
        {
            return await TryPersistAsync(message, ct).ConfigureAwait(false);
        }

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await IpcChannel.WriteMessageAsync(_pipe, message, ct).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            _logger.LogWarning(ex, "Lost the connection to the agent service; message will be queued for retry");
            ConnectionStateChanged?.Invoke(false);
            return await TryPersistAsync(message, ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    internal async Task<bool> TryPersistAsync(IpcMessage message, CancellationToken ct = default)
    {
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _pendingMessages.Enqueue(message);
            _logger.LogWarning("Queued IPC message {Type} because the service pipe is unavailable", message.GetType().Name);
            return true;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task FlushPendingMessagesAsync(CancellationToken ct)
    {
        var pending = _pendingMessages.DequeueAll();
        if (pending.Count == 0) return;

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_pipe is not { IsConnected: true })
            {
                _pendingMessages.EnqueueRange(pending);
                return;
            }

            foreach (var message in pending)
            {
                try
                {
                    await IpcChannel.WriteMessageAsync(_pipe, message, ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    _logger.LogWarning(ex, "Could not replay queued IPC message {Type}; it remains queued", message.GetType().Name);
                    _pendingMessages.EnqueueRange(pending.SkipWhile(m => !ReferenceEquals(m, message)));
                    return;
                }
            }
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_readerCts is not null)
        {
            await _readerCts.CancelAsync().ConfigureAwait(false);
            _readerCts.Dispose();
        }

        if (_pipe is not null) await _pipe.DisposeAsync().ConfigureAwait(false);
        _writeLock.Dispose();
    }
}
