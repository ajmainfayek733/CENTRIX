using System.Management;
using System.Runtime.Versioning;

namespace Agent.Native;

/// <summary>
/// Standard, well-documented WMI associator-query pattern: Win32_DiskDrive (filtered to USB
/// interface) -> Win32_DiskDriveToDiskPartition -> Win32_LogicalDiskToPartition ->
/// Win32_LogicalDisk. PNPDeviceID (from Win32_DiskDrive) is used as the stable device identity
/// rather than SerialNumber — cheap flash drives are well known to report duplicate or blank
/// serial numbers, while PNPDeviceID is Windows-assigned per physical enumeration and reliably
/// unique, so it's used ahead of the spec's literal Serial-first priority for that reason.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WmiUsbDeviceEnumerator : IUsbDeviceEnumerator
{
    public IReadOnlyList<UsbDriveSnapshot> EnumerateUsbDrives()
    {
        var results = new List<UsbDriveSnapshot>();

        using var driveSearcher = new ManagementObjectSearcher("SELECT * FROM Win32_DiskDrive WHERE InterfaceType = 'USB'");
        foreach (var drive in driveSearcher.Get().Cast<ManagementObject>())
        {
            using (drive)
            {
                var deviceId = drive["DeviceID"] as string ?? string.Empty;
                var pnpId = drive["PNPDeviceID"] as string;
                if (string.IsNullOrEmpty(pnpId))
                {
                    continue;
                }

                results.Add(new UsbDriveSnapshot(
                    pnpId,
                    (drive["SerialNumber"] as string)?.Trim(),
                    drive["Model"] as string,
                    drive["Manufacturer"] as string,
                    ParseCapacity(drive["Size"]),
                    EnumerateVolumes(deviceId)));
            }
        }

        return results;
    }

    private static List<UsbVolumeSnapshot> EnumerateVolumes(string diskDriveDeviceId)
    {
        var volumes = new List<UsbVolumeSnapshot>();

        using var partitionSearcher = new ManagementObjectSearcher(
            $"ASSOCIATORS OF {{Win32_DiskDrive.DeviceID='{EscapeWmiPath(diskDriveDeviceId)}'}} WHERE AssocClass = Win32_DiskDriveToDiskPartition");

        foreach (var partition in partitionSearcher.Get().Cast<ManagementObject>())
        {
            using (partition)
            {
                var partitionId = partition["DeviceID"] as string ?? string.Empty;

                using var logicalDiskSearcher = new ManagementObjectSearcher(
                    $"ASSOCIATORS OF {{Win32_DiskPartition.DeviceID='{EscapeWmiPath(partitionId)}'}} WHERE AssocClass = Win32_LogicalDiskToPartition");

                foreach (var logicalDisk in logicalDiskSearcher.Get().Cast<ManagementObject>())
                {
                    using (logicalDisk)
                    {
                        volumes.Add(new UsbVolumeSnapshot(
                            logicalDisk["DeviceID"] as string,
                            logicalDisk["VolumeName"] as string,
                            logicalDisk["FileSystem"] as string));
                    }
                }
            }
        }

        return volumes;
    }

    private static long? ParseCapacity(object? sizeValue) =>
        sizeValue is string sizeText && long.TryParse(sizeText, out var size) ? size : null;

    // WMI query-string paths need backslashes doubled (Microsoft Learn: WQL string literal rules).
    private static string EscapeWmiPath(string value) => value.Replace(@"\", @"\\");
}
