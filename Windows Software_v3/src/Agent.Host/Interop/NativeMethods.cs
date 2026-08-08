using System.Runtime.InteropServices;
using System.Text;

namespace Agent.Host.Interop;

/// <summary>
/// Win32 entry points used by the interactive collectors. All of these are session-bound —
/// they only return meaningful values from a process running on the user's desktop, which is
/// why this half of the agent exists as a separate executable from the service.
/// </summary>
internal static partial class NativeMethods
{
    // -- Foreground window ---------------------------------------------------

    [LibraryImport("user32.dll")]
    internal static partial IntPtr GetForegroundWindow();

    [LibraryImport("user32.dll", SetLastError = true)]
    internal static partial uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [LibraryImport("user32.dll", SetLastError = true)]
    internal static partial int GetWindowTextLengthW(IntPtr hWnd);

    /// <summary>Reads the foreground window's title, or empty when it has none.</summary>
    internal static string GetWindowTitle(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return string.Empty;

        var length = GetWindowTextLengthW(hWnd);
        if (length <= 0) return string.Empty;

        // +1 for the terminating null GetWindowTextW writes.
        var buffer = new StringBuilder(length + 1);
        var copied = GetWindowTextW(hWnd, buffer, buffer.Capacity);
        return copied > 0 ? buffer.ToString() : string.Empty;
    }

    // -- Idle detection ------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    internal struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetLastInputInfo(ref LASTINPUTINFO plii);

    /// <summary>
    /// Time since the last keyboard or mouse input anywhere in this session.
    ///
    /// GetLastInputInfo and GetTickCount both report 32-bit millisecond counters that wrap
    /// after ~49.7 days of uptime. Subtracting them as unsigned handles the wrap correctly, so
    /// a long-uptime workstation does not suddenly report a 49-day idle time.
    /// </summary>
    internal static TimeSpan GetIdleTime()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return TimeSpan.Zero;

        var elapsed = unchecked((uint)Environment.TickCount - info.dwTime);
        return TimeSpan.FromMilliseconds(elapsed);
    }

    // -- Low-level input hooks (counts only) ---------------------------------

    internal const int WH_KEYBOARD_LL = 13;
    internal const int WH_MOUSE_LL = 14;

    internal const int WM_KEYDOWN = 0x0100;
    internal const int WM_SYSKEYDOWN = 0x0104;

    internal const int WM_LBUTTONDOWN = 0x0201;
    internal const int WM_RBUTTONDOWN = 0x0204;
    internal const int WM_MBUTTONDOWN = 0x0207;
    internal const int WM_XBUTTONDOWN = 0x020B;

    internal delegate IntPtr LowLevelHookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr SetWindowsHookExW(int idHook, LowLevelHookProc lpfn, IntPtr hMod, uint dwThreadId);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool UnhookWindowsHookEx(IntPtr hhk);

    [LibraryImport("user32.dll")]
    internal static partial IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    internal static partial IntPtr GetModuleHandleW(string? lpModuleName);
}
