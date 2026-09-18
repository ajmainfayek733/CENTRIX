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

    // -- Accessibility event hooks ------------------------------------------

    /// <summary>
    /// Raised when the foreground window changes. An out-of-context hook delivers callbacks on
    /// the registering thread's message loop, so the host registers it on WPF's UI thread and
    /// does no collection work in the callback itself.
    /// </summary>
    internal const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    internal const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    internal const uint WINEVENT_SKIPOWNPROCESS = 0x0002;

    internal delegate void WinEventProc(
        IntPtr hook,
        uint eventType,
        IntPtr windowHandle,
        int objectId,
        int childId,
        uint eventThreadId,
        uint eventTime);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr module,
        WinEventProc callback,
        uint processId,
        uint threadId,
        uint flags);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool UnhookWinEvent(IntPtr hook);

    // -- Process identity ----------------------------------------------------

    /// <summary>
    /// The least privilege that still answers "what is this executable, and is it the same
    /// process I saw last time" - the documented requirement for QueryFullProcessImageName and
    /// GetProcessTimes is this right or the broader PROCESS_QUERY_INFORMATION.
    ///
    /// Deliberately the limited one. PROCESS_QUERY_INFORMATION is on the list of rights Windows
    /// refuses outright against a protected process; PROCESS_QUERY_LIMITED_INFORMATION exists
    /// precisely to expose a subset that survives that restriction, and it is also granted across
    /// integrity levels. Asking for more would mean logging an elevated or protected application
    /// as unknown for no gain.
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

        // No handle: the process exited between reading its window and this call, or its DACL
        // denies even this right. Expected on a normal desktop and not worth an error - the
        // caller degrades to the window title alone.
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
    /// Time since the last keyboard or mouse input in this session.
    ///
    /// Session-specific by design, and the reason idle detection lives in the per-user host
    /// rather than in the SYSTEM service: GetLastInputInfo reports only for the session that
    /// called it, so a service in session 0 would see nothing the employee does.
    ///
    /// Two counter hazards, both documented and both handled below.
    ///
    /// GetLastInputInfo and GetTickCount are 32-bit millisecond counters that wrap after ~49.7
    /// days of uptime. Subtracting as unsigned handles the wrap, so a long-uptime workstation
    /// does not suddenly report a 49-day idle time.
    ///
    /// And dwTime is explicitly "not guaranteed to be incremental" - a timing gap between the raw
    /// input thread and the desktop thread, or a SendInput event carrying its own tick count, can
    /// leave it *ahead* of the tick count we read. The unsigned subtraction then underflows to
    /// most of the counter range, which would report an active user as weeks idle and escalate a
    /// Critical inactivity alert at them. Anything past half the range is that skew rather than
    /// elapsed time: a genuine idle period of 24 days is not a case worth preserving, and a
    /// workstation is not idle while someone is typing at it.
    ///
    /// Sleep is deliberately not special-cased here. GetTickCount includes time spent asleep, so
    /// a machine resumed after three hours correctly reports three hours of idleness; the
    /// orchestrator decides separately what to do with a stretch it never observed.
    /// </summary>
    internal static TimeSpan GetIdleTime()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return TimeSpan.Zero;

        var elapsed = unchecked((uint)Environment.TickCount - info.dwTime);

        return elapsed > CounterSkewCeiling
            ? TimeSpan.Zero
            : TimeSpan.FromMilliseconds(elapsed);
    }

    /// <summary>
    /// Half the 32-bit millisecond counter range, ~24.8 days. Above this, a computed idle time is
    /// counter skew rather than a measurement.
    /// </summary>
    private const uint CounterSkewCeiling = uint.MaxValue / 2;

    // -- Session end -----------------------------------------------------------
    //
    // WM_QUERYENDSESSION asks whether the session may end; WM_ENDSESSION then reports what was
    // decided, and its wParam is the whole point of watching for it: FALSE means the logoff or
    // shutdown was called off. There is no managed equivalent - SystemEvents surfaces the query
    // as SessionEnding and the confirmation as SessionEnded, but nothing at all for the
    // cancellation - so this pair is read directly off the window procedure.

    internal const int WM_QUERYENDSESSION = 0x0011;
    internal const int WM_ENDSESSION = 0x0016;

    /// <summary>
    /// Not a session end at all: the Restart Manager is closing the application because a file it
    /// holds must be replaced, or the system is being serviced. The employee has not gone
    /// anywhere, and the agent is expected to be restarted.
    /// </summary>
    internal const uint ENDSESSION_CLOSEAPP = 0x00000001;

    /// <summary>The end is forced - the application does not get to refuse it.</summary>
    internal const uint ENDSESSION_CRITICAL = 0x40000000;

    /// <summary>The user is logging off, as opposed to shutting the machine down or restarting it.</summary>
    internal const uint ENDSESSION_LOGOFF = 0x80000000;

    /// <summary>Keeps the message-only listener window out of the taskbar and the alt-tab list.</summary>
    internal const int WS_EX_TOOLWINDOW = 0x00000080;

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
