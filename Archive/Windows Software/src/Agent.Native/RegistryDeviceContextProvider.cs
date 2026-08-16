using System.Runtime.Versioning;
using Agent.Core.Identity;
using Microsoft.Win32;

namespace Agent.Native;

/// <summary>
/// MachineGuid (HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid) is the standard, documented,
/// stable-across-reinstalls machine identifier used by many Microsoft components for exactly
/// this purpose. OrganizationId comes from policy/config, not the registry, and is populated
/// once the backend assigns one - empty until then.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class RegistryDeviceContextProvider : IDeviceContextProvider
{
    private readonly Lock _gate = new();
    private DeviceContext? _cached;
    private string _organizationId = string.Empty;

    public string OrganizationId
    {
        get => _organizationId;
        set
        {
            lock (_gate)
            {
                _organizationId = value;
                _cached = null;
            }
        }
    }

    public DeviceContext Current
    {
        get
        {
            lock (_gate)
            {
                return _cached ??= new DeviceContext(ReadMachineGuid(), _organizationId, Environment.MachineName);
            }
        }
    }

    private static string ReadMachineGuid()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        return key?.GetValue("MachineGuid") as string ?? Guid.NewGuid().ToString();
    }
}
