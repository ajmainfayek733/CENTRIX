using Agent.Native;

namespace Agent.Collectors.Usb;

public interface IUsbLogRepository
{
    /// <summary>Devices with a recorded Inserted event and no later Removed event - the
    /// reconciliation baseline restored at startup so "agent restarts while USB remains
    /// connected" doesn't spuriously re-fire an Inserted event.</summary>
    Task<IReadOnlyDictionary<string, UsbDriveSnapshot>> GetCurrentlyPresentAsync(CancellationToken cancellationToken);

    Task RecordEventAsync(UsbDeviceEvent deviceEvent, CancellationToken cancellationToken);
}
