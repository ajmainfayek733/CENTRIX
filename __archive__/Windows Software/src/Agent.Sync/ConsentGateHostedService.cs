using Agent.Core.Consent;
using Agent.Core.Identity;
using Agent.Core.Policy;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Sync;

/// <summary>
/// Agent.Host (the Session-0 service) has no interactive desktop and so cannot show the consent
/// dialog itself - that only happens in Agent.TrayHelper, once a user is logged in. This polls
/// the shared consent store for an acknowledgement recorded by any user on this machine and
/// flips <see cref="ConsentGate"/> once one is found at or above the current policy version, so
/// SyncWorker and ScreenshotUploadWorker know not to transmit anything before that happens.
/// Runs as a lightweight timer rather than blocking StartAsync, since a long-blocking OnStart
/// would risk the Windows Service Control Manager's start timeout (see AgentWindowsService).
/// </summary>
public sealed class ConsentGateHostedService(
    IConsentStore consentStore,
    IPolicyProvider policyProvider,
    IDeviceContextProvider deviceContext,
    ConsentGate gate,
    ILogger<ConsentGateHostedService> logger) : IHostedService, IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(15);

    private Timer? _timer;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new Timer(_ => _ = PollAsync(), null, TimeSpan.Zero, PollInterval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private async Task PollAsync()
    {
        if (gate.IsAcknowledged)
        {
            _timer?.Dispose();
            return;
        }

        try
        {
            var machineId = deviceContext.Current.MachineId;
            var record = await consentStore.GetLatestForMachineAsync(machineId, CancellationToken.None).ConfigureAwait(false);
            if (record is not null && record.PolicyVersion >= policyProvider.Current.Version)
            {
                gate.Grant();
                logger.LogInformation(
                    "Consent acknowledgement found for this device (policy v{Version}, acknowledged {AcknowledgedAtUtc:u}); sync enabled.",
                    record.PolicyVersion,
                    record.AcknowledgedAtUtc);
                _timer?.Dispose();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to check consent acknowledgement status.");
        }
    }
}
