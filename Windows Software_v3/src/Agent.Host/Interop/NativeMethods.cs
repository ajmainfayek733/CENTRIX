using System.Runtime.InteropServices;
using System.Text;

namespace Agent.Host.Interop;

/// <summary>
/// Win32 entry points used by the interactive collectors. All of these are session-bound -
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

    // -- Process identity ----------------------------------------------------

    /// <summary>
    /// The least privilege that still answers "what is this executable, and is it the same
    /// process I saw last time". Deliberately not PROCESS_QUERY_INFORMATION: the limited right
    /// is granted across integrity levels, so a standard-user agent can still name an elevated
    /// application instead of logging it as unknown.
    /// </summary>
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    /// <summary>Win32 ERROR_INSUFFICIENT_BUFFER, the retry signal from QueryFullProcessImageName.</summary>
    private const int ErrorInsufficientBuffer = 122;

    /// <summary>Path lengths. The first is the common case; the second is the NTFS ceiling.</summary>
    private const int ShortPathCapacity = 260;
    private const int ExtendedPathCapacity = 32767;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    internal static partial IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder exeName, ref uint size);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    /// <summary>
    /// Identifies the process behind a window: its executable path and the instant it started.
    ///
    /// The start time is not decoration. Windows reuses process ids aggressively, so a cache
    /// keyed on the id alone will eventually attribute one application's time to another once
    /// the original exits and a new process inherits its id. The pair is unique for the life of
    /// the machine.
    ///
    /// QueryFullProcessImageName rather than the managed Process.MainModule: MainModule
    /// enumerates every loaded module of the target process to return the first one, which for a
    /// browser is hundreds of DLLs of work for a value the kernel already holds. It also fails
    /// outright across integrity levels, which is why elevated applications previously logged
    /// with no path at all.
    /// </summary>
    internal static (string? Path, long StartedAtTicks) QueryProcessIdentity(uint processId)
    {
        if (processId == 0) return (null, 0);

        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);

        // A protected process (anti-malware, some system services) refuses the handle. That is
        // expected on a normal desktop and is not worth an error - the caller degrades to the
        // window title alone.
        if (handle == IntPtr.Zero) return (null, 0);

        try
        {
            var path = ReadImagePath(handle);
            var startedAt = GetProcessTimes(handle, out var creation, out _, out _, out _) ? creation : 0;
            return (path, startedAt);
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    private static string? ReadImagePath(IntPtr processHandle)
    {
        var capacity = (uint)ShortPathCapacity;
        var buffer = new StringBuilder(ShortPathCapacity);

        if (QueryFullProcessImageNameW(processHandle, 0, buffer, ref capacity))
        {
            return buffer.ToString(0, (int)capacity);
        }

        // Long paths are rare enough that the big buffer is only ever allocated for the
        // executables that actually need it.
        if (Marshal.GetLastWin32Error() != ErrorInsufficientBuffer) return null;

        capacity = ExtendedPathCapacity;
        buffer = new StringBuilder(ExtendedPathCapacity);

        return QueryFullProcessImageNameW(processHandle, 0, buffer, ref capacity)
            ? buffer.ToString(0, (int)capacity)
            : null;
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
