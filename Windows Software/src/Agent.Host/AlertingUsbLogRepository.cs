using Agent.Alerts;
using Agent.Collectors.Usb;

namespace Agent.Host;

/// <summary>
/// Decorator, not a modification to Agent.Collectors - Collectors has no dependency on Alerts
/// (only Alerts depends on Collectors, to avoid a cycle), so triggering the alert engine after
/// a successful write happens here at the composition root instead.
/// </summary>
public sealed class AlertingUsbLogRepository(IUsbLogRepository inner, AlertEngine<UsbDeviceEvent> alertEngine) : IUsbLogRepository
{
    public Task<IReadOnlyDictionary<string, Agent.Native.UsbDriveSnapshot>> GetCurrentlyPresentAsync(CancellationToken cancellationToken) =>
        inner.GetCurrentlyPresentAsync(cancellationToken);

    public async Task RecordEventAsync(UsbDeviceEvent deviceEvent, CancellationToken cancellationToken)
    {
        await inner.RecordEventAsync(deviceEvent, cancellationToken).ConfigureAwait(false);
        await alertEngine.ProcessAsync(deviceEvent, deviceEvent.MachineId, deviceEvent.UserSid, cancellationToken).ConfigureAwait(false);
    }
}
