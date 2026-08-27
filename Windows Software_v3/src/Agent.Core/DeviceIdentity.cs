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
/// laptop with Wi-Fi, Ethernet and a dock reports three of them - so MAC is collected and
/// reported as an attribute, while MachineGuid is the key the backend uniques on.
/// </summary>
public static class DeviceIdentity
{
    private const int Windows11MinimumBuild = 22000;

    /// <summary>
    /// HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid - stable for the life of the OS install
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
    /// Caches the first hardware address successfully resolved.
    ///
    /// The service starts at boot, and the enrollment that reads this can run before Windows has
    /// finished bringing the NICs up. Once a real address has been seen it never changes for the
    /// life of the machine, so holding on to it means a later call cannot regress to "unknown"
    /// just because an adapter was disabled or a cable was pulled.
    /// </summary>
    private static string? _cachedMacAddress;

    /// <summary>
    /// The MAC of the best available physical adapter, or null when none can be determined.
    ///
    /// WHY THIS IS NOT A ONE-LINER: the previous version required an adapter that was
    /// <see cref="OperationalStatus.Up"/> *and* physical *and* not virtual-sounding, and returned
    /// 00:00:00:00:00:00 when nothing matched. All three conditions fail routinely -
    ///
    ///   - the service starts at boot and enrolls before any adapter reaches Up;
    ///   - a laptop on Wi-Fi with the dock unplugged has no Ethernet at all;
    ///   - on a host with Hyper-V or WSL2 the adapter carrying traffic is described as virtual.
    ///
    /// so the zero address was not an edge case, it was the common result. And because it is a
    /// well-formed string, nothing downstream could tell it apart from a real address: every
    /// affected device showed the same MAC in the dashboard, and the index on that column pointed
    /// them all at each other.
    ///
    /// The fix is to widen the search in tiers rather than fail to a placeholder, and to return
    /// null - which the whole chain now models - when even the widest tier finds nothing.
    /// </summary>
    public static string? GetPrimaryMacAddress()
    {
        if (_cachedMacAddress is not null) return _cachedMacAddress;

        var adapters = NetworkInterface.GetAllNetworkInterfaces()
            .Where(nic => nic.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
            .Where(nic => HasUsableAddress(nic))
            .ToList();

        // Tier 1: a real, connected, physical adapter - the answer we want.
        // Tier 2: a physical adapter that simply is not up yet, or is currently unplugged. Its
        //         address is burned into the same hardware either way, which is the property
        //         Features.md actually cares about.
        // Tier 3: anything left, including virtual adapters. A machine whose only NIC is a
        //         Hyper-V vSwitch still deserves a stable identifier over none at all.
        var candidate =
            Best(adapters.Where(nic => nic.OperationalStatus == OperationalStatus.Up && !IsVirtualAdapter(nic.Description)))
            ?? Best(adapters.Where(nic => !IsVirtualAdapter(nic.Description)))
            ?? Best(adapters);

        if (candidate is null) return null;

        _cachedMacAddress = Format(candidate.GetPhysicalAddress());
        return _cachedMacAddress;
    }

    /// <summary>Ethernet before Wi-Fi before anything else, then by name so the pick is stable.</summary>
    private static NetworkInterface? Best(IEnumerable<NetworkInterface> adapters) =>
        adapters
            .OrderBy(nic => nic.NetworkInterfaceType switch
            {
                NetworkInterfaceType.Ethernet => 0,
                NetworkInterfaceType.Wireless80211 => 1,
                _ => 2
            })
            .ThenBy(nic => nic.Id, StringComparer.Ordinal)
            .FirstOrDefault();

    /// <summary>
    /// True when the adapter reports an address that identifies something.
    ///
    /// The all-zero address is rejected here rather than downstream: it is not an address, it is
    /// what the API returns for an adapter that has none, and treating it as data is the whole
    /// bug this method exists to fix.
    /// </summary>
    private static bool HasUsableAddress(NetworkInterface nic)
    {
        var bytes = nic.GetPhysicalAddress().GetAddressBytes();
        return bytes.Length > 0 && bytes.Any(b => b != 0);
    }

    /// <summary>Canonical uppercase colon-separated form, matching what the server stores.</summary>
    private static string Format(PhysicalAddress address) =>
        string.Join(":", address.GetAddressBytes().Select(b => b.ToString("X2")));

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

        var productName = key?.GetValue("ProductName") as string;
        if (string.IsNullOrWhiteSpace(productName)) return RuntimeInformation.OSDescription;

        var build = int.TryParse(key?.GetValue("CurrentBuildNumber")?.ToString(), out var parsedBuild)
            ? parsedBuild
            : 0;

        return build >= Windows11MinimumBuild &&
            productName.StartsWith("Windows 10", StringComparison.OrdinalIgnoreCase)
            ? "Windows 11" + productName["Windows 10".Length..]
            : productName;
    }

    /// <summary>e.g. "10.0.26200".</summary>
    public static string GetOsVersion() => Environment.OSVersion.Version.ToString();

    /// <summary>e.g. "64-bit operating system, x64-based processor" - the System Information wording.</summary>
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
