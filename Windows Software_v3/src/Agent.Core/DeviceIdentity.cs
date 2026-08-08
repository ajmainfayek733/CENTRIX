using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.InteropServices;
using Agent.Core.Contracts;
using Microsoft.Win32;

namespace Agent.Core;

/// <summary>
/// Builds the device profile from Features.md "Device Information".
///
/// Identity is the Windows MachineGuid, not the MAC address. Features.md notes MAC is burned
/// into hardware while IPs change, which is true, but MAC is also trivially spoofable and a
/// laptop with Wi-Fi, Ethernet and a dock reports three of them — so MAC is collected and
/// reported as an attribute, while MachineGuid is the key the backend uniques on.
/// </summary>
public static class DeviceIdentity
{
    /// <summary>
    /// HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid — stable for the life of the OS install
    /// and unchanged by hardware swaps, renames or re-IPing.
    /// </summary>
    public static string GetMachineGuid()
    {
        using var key = RegistryKey
            .OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64)
            .OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");

        var guid = key?.GetValue("MachineGuid") as string;

        // A machine with no MachineGuid is not a supported configuration, but falling back to
        // the machine name keeps the agent enrolling instead of crash-looping at boot.
        return string.IsNullOrWhiteSpace(guid) ? $"fallback-{Environment.MachineName}" : guid;
    }

    /// <summary>
    /// The MAC of the first operational physical adapter. Loopback and tunnel adapters are
    /// skipped, as are the virtual adapters Hyper-V, VPN clients and Docker install — those
    /// change independently of the hardware and would make the value useless as an attribute.
    /// </summary>
    public static string GetPrimaryMacAddress()
    {
        var candidate = NetworkInterface.GetAllNetworkInterfaces()
            .Where(nic => nic.OperationalStatus == OperationalStatus.Up)
            .Where(nic => nic.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
            .Where(nic => !IsVirtualAdapter(nic.Description))
            .OrderBy(nic => nic.NetworkInterfaceType == NetworkInterfaceType.Ethernet ? 0 : 1)
            .FirstOrDefault();

        var bytes = candidate?.GetPhysicalAddress().GetAddressBytes();
        return bytes is { Length: > 0 }
            ? string.Join(":", bytes.Select(b => b.ToString("X2")))
            : "00:00:00:00:00:00";
    }

    private static bool IsVirtualAdapter(string description) =>
        description.Contains("virtual", StringComparison.OrdinalIgnoreCase) ||
        description.Contains("hyper-v", StringComparison.OrdinalIgnoreCase) ||
        description.Contains("vmware", StringComparison.OrdinalIgnoreCase) ||
        description.Contains("virtualbox", StringComparison.OrdinalIgnoreCase) ||
        description.Contains("tap-", StringComparison.OrdinalIgnoreCase) ||
        description.Contains("pseudo", StringComparison.OrdinalIgnoreCase);

    /// <summary>e.g. "Windows 11 Pro", read from the registry rather than inferred from the build number.</summary>
    public static string GetEdition()
    {
        using var key = RegistryKey
            .OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64)
            .OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");

        return key?.GetValue("ProductName") as string ?? RuntimeInformation.OSDescription;
    }

    /// <summary>e.g. "10.0.26200".</summary>
    public static string GetOsVersion() => Environment.OSVersion.Version.ToString();

    /// <summary>e.g. "64-bit operating system, x64-based processor" — the System Information wording.</summary>
    public static string GetSystemType()
    {
        var bitness = Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit";
        return $"{bitness} operating system, {RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant()}-based processor";
    }

    /// <summary>Read from the assembly metadata written by Directory.Build.props.</summary>
    public static string GetAgentVersion() =>
        Assembly.GetEntryAssembly()?
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "AgentVersion")?.Value
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
        ?? "0.0.0";

    public static DeviceRegistration BuildRegistration() => new()
    {
        DeviceId = GetMachineGuid(),
        DeviceName = Environment.MachineName,
        SystemType = GetSystemType(),
        Edition = GetEdition(),
        Version = GetOsVersion(),
        MacAddress = GetPrimaryMacAddress(),
        AgentVersion = GetAgentVersion()
    };
}
