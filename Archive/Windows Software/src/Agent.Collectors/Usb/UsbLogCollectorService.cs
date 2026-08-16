using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Time;
using Agent.Native;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Usb;

/// <summary>
/// USB belongs to the machine, not to a desktop session - this runs once per machine (service
/// context), independent of which user is logged in, per the spec's multi-user-systems rule.
/// </summary>
public sealed class UsbLogCollectorService(
    IUsbDeviceEnumerator deviceEnumerator,
    IWtsSessionInfoProvider wtsSessionInfo,
    IDeviceContextProvider deviceContext,
    IUsbLogRepository repository,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<UsbLogCollectorService> logger) : IHostedService, IDisposable
{
    private Timer? _timer;
    private Dictionary<string, UsbDriveSnapshot> _knownPresent = [];

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var baseline = await repository.GetCurrentlyPresentAsync(cancellationToken).ConfigureAwait(false);
        _knownPresent = new Dictionary<string, UsbDriveSnapshot>(baseline);

        var interval = policyProvider.Current.Usb.ReconciliationInterval;
        _timer = new Timer(_ => _ = ReconcileAsync(), null, TimeSpan.Zero, interval);
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private async Task ReconcileAsync()
    {
        if (!policyProvider.Current.Usb.Enabled)
        {
            return;
        }

        try
        {
            var current = deviceEnumerator.EnumerateUsbDrives();
            var result = UsbReconciliationEngine.Reconcile(_knownPresent, current);
            var nowUtc = clock.UtcNow;

            foreach (var inserted in result.Inserted)
            {
                _knownPresent[inserted.PnpDeviceId] = inserted;
                await RecordAsync(inserted, UsbEventType.Inserted, nowUtc).ConfigureAwait(false);
            }

            foreach (var changed in result.MetadataChanged)
            {
                _knownPresent[changed.PnpDeviceId] = changed;
                await RecordAsync(changed, UsbEventType.MetadataChanged, nowUtc).ConfigureAwait(false);
            }

            foreach (var removed in result.Removed)
            {
                _knownPresent.Remove(removed.PnpDeviceId);
                await RecordAsync(removed, UsbEventType.Removed, nowUtc).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "USB reconciliation tick failed.");
        }
    }

    private async Task RecordAsync(UsbDriveSnapshot snapshot, UsbEventType eventType, DateTimeOffset atUtc)
    {
        var activeConsoleSessionId = wtsSessionInfo.GetActiveConsoleSessionId();
        var userSid = wtsSessionInfo.TryGetUserSid(activeConsoleSessionId) ?? string.Empty;

        var deviceEvent = new UsbDeviceEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = deviceContext.Current.MachineId,
            UserSid = userSid,
            PnpDeviceId = snapshot.PnpDeviceId,
            SerialNumber = snapshot.SerialNumber,
            Model = snapshot.Model,
            Manufacturer = snapshot.Manufacturer,
            CapacityBytes = snapshot.CapacityBytes,
            Volumes = snapshot.Volumes,
            EventType = eventType,
            OccurredAtUtc = atUtc
        };

        logger.LogInformation(
            "USB {EventType}: {PnpDeviceId} ({Model}, {Manufacturer}).",
            eventType,
            snapshot.PnpDeviceId,
            snapshot.Model,
            snapshot.Manufacturer);

        await repository.RecordEventAsync(deviceEvent, CancellationToken.None).ConfigureAwait(false);
    }
}
