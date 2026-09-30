using System.Management;
using System.Text.RegularExpressions;
using Agent.Core.Contracts;
using Agent.Core.Storage;
using Agent.Service.Ipc;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Workers;

/// <summary>
/// Features.md "USB Logs". Records device connection and removal only - the service never
/// enumerates, opens, reads or copies the contents of a connected device.
///
/// Runs in the service rather than the host because WMI device events are machine-scoped: they
/// arrive whether or not anyone is logged on, so a drive plugged into a locked workstation is
/// still recorded.
/// </summary>
public sealed partial class UsbWorker(
    AgentState state,
    TelemetryQueue queue,
    IpcServer ipc,
    ILogger<UsbWorker> logger) : BackgroundService
{
    private readonly AgentState _state = state;
    private readonly TelemetryQueue _queue = queue;
    private readonly IpcServer _ipc = ipc;
    private readonly ILogger<UsbWorker> _logger = logger;

    [GeneratedRegex(@"VID_([0-9A-F]{4})", RegexOptions.IgnoreCase)]
    private static partial Regex VendorIdPattern();

    [GeneratedRegex(@"PID_([0-9A-F]{4})", RegexOptions.IgnoreCase)]
    private static partial Regex ProductIdPattern();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // WMI event subscriptions are synchronous COM plumbing; keeping them off the host's
        // startup path means a WMI stall cannot delay the rest of the service coming up.
        await Task.Yield();

        while (!stoppingToken.IsCancellationRequested)
        {
            if (!_state.Policy.Usb.Enabled)
            {
                await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken).ConfigureAwait(false);
                continue;
            }

            try
            {
                await WatchAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (ManagementException ex)
            {
                _logger.LogError(ex, "WMI device watcher failed; retrying in 30s");
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken).ConfigureAwait(false);
            }
        }
    }

    private async Task WatchAsync(CancellationToken ct)
    {
        var pollSeconds = Math.Max(_state.Policy.Usb.ReconciliationIntervalSeconds, 1);

        // WITHIN sets how often WMI polls for the change. Win32_PnPEntity has no push
        // notification, so this interval is the detection latency; the policy default of 5s
        // trades a little CPU for catching a drive that is plugged and pulled quickly.
        var arrivalQuery = new WqlEventQuery(
            $"SELECT * FROM __InstanceCreationEvent WITHIN {pollSeconds} " +
            "WHERE TargetInstance ISA 'Win32_PnPEntity'");

        var removalQuery = new WqlEventQuery(
            $"SELECT * FROM __InstanceDeletionEvent WITHIN {pollSeconds} " +
            "WHERE TargetInstance ISA 'Win32_PnPEntity'");

        using var arrivals = new ManagementEventWatcher(arrivalQuery);
        using var removals = new ManagementEventWatcher(removalQuery);

        arrivals.EventArrived += (_, e) => OnDeviceEvent(e, UsbEventType.Connected);
        removals.EventArrived += (_, e) => OnDeviceEvent(e, UsbEventType.Disconnected);

        arrivals.Start();
        removals.Start();
        _logger.LogInformation("USB device watcher started (polling every {Seconds}s)", pollSeconds);

        try
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, ct).ConfigureAwait(false);
        }
        finally
        {
            arrivals.Stop();
            removals.Stop();
        }
    }

    private void OnDeviceEvent(EventArrivedEventArgs args, UsbEventType eventType)
    {
        try
        {
            if (args.NewEvent["TargetInstance"] is not ManagementBaseObject target) return;

            var pnpDeviceId = target["PNPDeviceID"] as string ?? string.Empty;
            if (!IsInterestingDevice(pnpDeviceId, target)) return;

            var deviceType = ClassifyDevice(pnpDeviceId, target["PNPClass"] as string);

            var usbEvent = new UsbEvent
            {
                ClientEventId = Guid.NewGuid(),
                SessionId = null,
                EventType = eventType,
                DeviceType = deviceType,
                FriendlyName = target["Name"] as string ?? target["Caption"] as string,
                Manufacturer = target["Manufacturer"] as string,
                Model = target["Description"] as string,
                SerialNumber = ExtractSerialNumber(pnpDeviceId),
                VendorId = Match(VendorIdPattern(), pnpDeviceId),
                ProductId = Match(ProductIdPattern(), pnpDeviceId),
                EventTime = DateTimeOffset.UtcNow
            };

            // Volume details only exist for storage, and only while it is attached - on
            // removal the drive letter is already gone, so enrichment is arrival-only.
            if (deviceType == UsbDeviceType.UsbStorage && eventType == UsbEventType.Connected)
            {
                usbEvent = EnrichWithVolumeDetails(usbEvent);
            }

            _queue.Enqueue(usbEvent);
            _logger.LogInformation("USB {EventType}: {Name} ({Type})",
                eventType, usbEvent.FriendlyName ?? "unknown device", deviceType);

            if (eventType == UsbEventType.Connected &&
                _state.Policy.Usb.AlertOnInsertion &&
                _state.Policy.Alert.Enabled)
            {
                RaiseInsertionAlert(usbEvent);
            }
        }
        catch (Exception ex)
        {
            // A malformed WMI instance must not tear down the watcher; skip this event.
            _logger.LogWarning(ex, "Failed to record a USB device event");
        }
    }

    /// <summary>
    /// Features.md scopes this to removable storage and phones. Every workstation enumerates
    /// dozens of internal PnP devices at boot, so anything that is not USB-attached, or is a
    /// hub or generic controller, is ignored.
    /// </summary>
    private static bool IsInterestingDevice(string pnpDeviceId, ManagementBaseObject target)
    {
        if (string.IsNullOrEmpty(pnpDeviceId)) return false;

        var isUsbAttached =
            pnpDeviceId.StartsWith("USB\\", StringComparison.OrdinalIgnoreCase) ||
            pnpDeviceId.StartsWith("USBSTOR\\", StringComparison.OrdinalIgnoreCase) ||
            pnpDeviceId.StartsWith("WPD\\", StringComparison.OrdinalIgnoreCase);

        if (!isUsbAttached) return false;

        var pnpClass = target["PNPClass"] as string;
        // Hubs and host controllers appear and disappear on their own during power
        // transitions and say nothing about what a person plugged in.
        return pnpClass is not ("USB" or "System");
    }

    private static UsbDeviceType ClassifyDevice(string pnpDeviceId, string? pnpClass)
    {
        if (pnpDeviceId.StartsWith("USBSTOR\\", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(pnpClass, "DiskDrive", StringComparison.OrdinalIgnoreCase))
        {
            return UsbDeviceType.UsbStorage;
        }

        if (pnpDeviceId.StartsWith("WPD\\", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(pnpClass, "WPD", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(pnpClass, "PortableDevice", StringComparison.OrdinalIgnoreCase))
        {
            return UsbDeviceType.MobileDevice;
        }

        if (string.Equals(pnpClass, "HIDClass", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(pnpClass, "Keyboard", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(pnpClass, "Mouse", StringComparison.OrdinalIgnoreCase))
        {
            return UsbDeviceType.Hid;
        }

        return UsbDeviceType.Other;
    }

    /// <summary>
    /// Walks Win32_DiskDrive to its partitions to its logical disks, to attach the drive
    /// letter, label, capacity and file system Features.md asks for.
    /// </summary>
    private UsbEvent EnrichWithVolumeDetails(UsbEvent usbEvent)
    {
        try
        {
            using var disks = new ManagementObjectSearcher(
                "SELECT DeviceID, Size, PNPDeviceID FROM Win32_DiskDrive WHERE InterfaceType = 'USB'");

            foreach (var disk in disks.Get().Cast<ManagementObject>())
            {
                using (disk)
                {
                    var diskPnpId = disk["PNPDeviceID"] as string ?? string.Empty;
                    var serial = ExtractSerialNumber(diskPnpId);

                    // Match the disk back to the device that raised the event. Serial is the
                    // reliable join; without it we cannot tell two identical sticks apart, so
                    // we skip rather than guess.
                    if (usbEvent.SerialNumber is null || serial != usbEvent.SerialNumber) continue;

                    var capacity = disk["Size"]?.ToString();
                    var (driveLetter, label, fileSystem) = FindLogicalDisk(disk);

                    return usbEvent with
                    {
                        CapacityBytes = capacity,
                        DriveLetter = driveLetter,
                        VolumeLabel = label,
                        FileSystem = fileSystem
                    };
                }
            }
        }
        catch (ManagementException ex)
        {
            _logger.LogDebug(ex, "Could not enrich USB storage event with volume details");
        }

        return usbEvent;
    }

    private static (string? DriveLetter, string? Label, string? FileSystem) FindLogicalDisk(ManagementObject disk)
    {
        foreach (var partition in disk.GetRelated("Win32_DiskPartition").Cast<ManagementObject>())
        {
            using (partition)
            {
                foreach (var logical in partition.GetRelated("Win32_LogicalDisk").Cast<ManagementObject>())
                {
                    using (logical)
                    {
                        return (
                            logical["DeviceID"] as string,
                            logical["VolumeName"] as string,
                            logical["FileSystem"] as string);
                    }
                }
            }
        }

        return (null, null, null);
    }

    private void RaiseInsertionAlert(UsbEvent usbEvent)
    {
        var name = usbEvent.FriendlyName ?? "Unknown device";

        _queue.Enqueue(new AlertEvent
        {
            ClientEventId = Guid.NewGuid(),
            UserSid = _state.ActiveUserSid ?? "S-1-0-0",
            Type = AlertType.UsbDeviceConnected,
            Severity = AlertSeverity.Warning,
            State = AlertState.New,
            Title = "Removable device connected",
            Message = $"{name} was connected to this workstation.",
            ContextUsbFriendlyName = name,
            ContextUsbSerialNumber = usbEvent.SerialNumber,
            TriggeredAt = usbEvent.EventTime,
            EscalationLevel = 0,
            NotificationCount = 1
        });

        _ = _ipc.BroadcastAsync(new Agent.Core.Ipc.ShowNotificationMessage
        {
            Title = "Removable device connected",
            Message = $"{name} was connected. This event has been logged.",
            Severity = AlertSeverity.Warning
        });
    }

    /// <summary>
    /// The last segment of a PNPDeviceID is the serial for most devices. Windows appends
    /// "&amp;0" style interface suffixes, and marks devices with no real serial by putting
    /// an ampersand in the second character position - those are reported as null rather than
    /// as a fake identifier that would collide across devices.
    /// </summary>
    private static string? ExtractSerialNumber(string pnpDeviceId)
    {
        if (string.IsNullOrEmpty(pnpDeviceId)) return null;

        var segments = pnpDeviceId.Split('\\');
        if (segments.Length < 3) return null;

        var candidate = segments[^1];
        var ampersand = candidate.IndexOf('&');
        if (ampersand > 0) candidate = candidate[..ampersand];

        if (candidate.Length < 2) return null;
        if (candidate.Length > 1 && candidate[1] == '&') return null;

        return candidate;
    }

    private static string? Match(Regex pattern, string input)
    {
        var match = pattern.Match(input);
        return match.Success ? match.Groups[1].Value.ToUpperInvariant() : null;
    }
}
