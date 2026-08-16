namespace Agent.Native;

public sealed record UsbVolumeSnapshot(string? DriveLetter, string? VolumeLabel, string? FileSystem);

public sealed record UsbDriveSnapshot(
    string PnpDeviceId,
    string? SerialNumber,
    string? Model,
    string? Manufacturer,
    long? CapacityBytes,
    IReadOnlyList<UsbVolumeSnapshot> Volumes);

public interface IUsbDeviceEnumerator
{
    IReadOnlyList<UsbDriveSnapshot> EnumerateUsbDrives();
}
