using System.Runtime.Versioning;
using Agent.Native.Interop;

namespace Agent.Native;

/// <summary>
/// Left/Top can be negative when a secondary monitor is positioned above/left of the primary -
/// GetSystemMetrics' virtual-screen metrics already account for this, for portrait monitors,
/// and for mixed-DPI setups, so no separate per-monitor topology calculation is needed just to
/// capture everything in one image.
/// </summary>
public readonly record struct VirtualScreenBounds(int Left, int Top, int Width, int Height, int MonitorCount);

public interface IVirtualScreenBoundsProvider
{
    VirtualScreenBounds GetBounds();
}

[SupportedOSPlatform("windows")]
public sealed class VirtualScreenBoundsProvider : IVirtualScreenBoundsProvider
{
    public VirtualScreenBounds GetBounds() => new(
        NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN),
        NativeMethods.GetSystemMetrics(NativeMethods.SM_CMONITORS));
}
