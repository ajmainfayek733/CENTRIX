using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Agent.Native.Interop;

/// <summary>
/// See Microsoft Learn: GetSystemMetrics (https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getsystemmetrics),
/// OpenInputDesktop (https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-openinputdesktop),
/// SetProcessDpiAwarenessContext (https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext).
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class NativeMethods
{
    internal const int SM_XVIRTUALSCREEN = 76;
    internal const int SM_YVIRTUALSCREEN = 77;
    internal const int SM_CXVIRTUALSCREEN = 78;
    internal const int SM_CYVIRTUALSCREEN = 79;
    internal const int SM_CMONITORS = 80;

    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, per Microsoft Learn's documented constant.
    internal static readonly nint DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

    private const uint DESKTOP_READOBJECTS = 0x0001;

    [LibraryImport("user32.dll")]
    internal static partial int GetSystemMetrics(int nIndex);

    [LibraryImport("user32.dll", SetLastError = true)]
    internal static partial nint OpenInputDesktop(uint dwFlags, [MarshalAs(UnmanagedType.Bool)] bool fInherit, uint dwDesiredAccess);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool CloseDesktop(nint hDesktop);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetProcessDpiAwarenessContext(nint value);

    internal static bool TryOpenInputDesktop(out nint handle)
    {
        handle = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        return handle != nint.Zero;
    }
}
