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
/// Everything the host observes is sent here; nothing is written to disk or uploaded from this
/// process. If the pipe is down, submissions are dropped rather than buffered in the host: the
/// service owns the durable queue, and duplicating that here would mean two stores that can
/// disagree. A dropped submission costs at most one polling interval of data, because the
/// service is restarted by the SCM far faster than a session lasts.
/// </summary>
public sealed class HostIpcClient(ILogger<HostIpcClient> logger) : IAsyncDisposable
{
    private readonly ILogger<HostIpcClient> _logger = logger;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    private NamedPipeClientStream? _pipe;
    private CancellationTokenSource? _readerCts;

    public bool IsConnected => _pipe?.IsConnected == true;

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
                PipeOptions.Asynchronous);

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
        if (_pipe is not { IsConnected: true }) return false;

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await IpcChannel.WriteMessageAsync(_pipe, message, ct).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            _logger.LogWarning(ex, "Lost the connection to the agent service");
            ConnectionStateChanged?.Invoke(false);
            return false;
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
