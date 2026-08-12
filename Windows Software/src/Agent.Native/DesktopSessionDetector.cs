using System.Runtime.Versioning;
using Agent.Native.Interop;

namespace Agent.Native;

public interface IDesktopSessionDetector
{
    /// <summary>False when the secure desktop is active (UAC elevation prompt, some lock-screen
    /// configurations) - capturing then would either fail or capture nothing meaningful.</summary>
    bool IsInteractiveDesktopAvailable();
}

[SupportedOSPlatform("windows")]
public sealed class DesktopSessionDetector : IDesktopSessionDetector
{
    public bool IsInteractiveDesktopAvailable()
    {
        if (!NativeMethods.TryOpenInputDesktop(out var handle))
        {
            return false;
        }

        NativeMethods.CloseDesktop(handle);
        return true;
    }
}
