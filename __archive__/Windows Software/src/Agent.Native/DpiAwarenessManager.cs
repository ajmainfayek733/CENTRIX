using System.Runtime.Versioning;
using Agent.Native.Interop;

namespace Agent.Native;

public interface IDpiAwarenessManager
{
    /// <summary>
    /// Must be called once, before any window is created or any DPI-dependent metric is read -
    /// per Microsoft Learn, DPI awareness can only be set once per process and takes effect from
    /// that point on. Without Per-Monitor-V2 awareness, virtual-screen metrics come back
    /// DPI-virtualized rather than as true pixel dimensions.
    /// </summary>
    bool TrySetPerMonitorV2Awareness();
}

[SupportedOSPlatform("windows")]
public sealed class DpiAwarenessManager : IDpiAwarenessManager
{
    public bool TrySetPerMonitorV2Awareness() =>
        NativeMethods.SetProcessDpiAwarenessContext(NativeMethods.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}
