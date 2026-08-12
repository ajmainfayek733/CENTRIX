using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Agent.Native.Interop;

/// <summary>
/// See Microsoft Learn: GetForegroundWindow (https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getforegroundwindow),
/// QueryFullProcessImageNameW (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-queryfullprocessimagenamew).
/// GetWindowTextW/QueryFullProcessImageNameW use classic DllImport with char[] buffers (per
/// CA1838, avoiding StringBuilder) rather than LibraryImport - LibraryImport's blittable-only
/// marshaller rejects an [Out] char[] buffer without opting the whole assembly out of runtime
/// marshalling (SYSLIB1051), which would also affect the bool-returning WTS P/Invokes below.
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class NativeMethods
{
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [LibraryImport("user32.dll")]
    internal static partial nint GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
    internal static extern int GetWindowTextW(nint hWnd, [Out] char[] lpString, int nMaxCount);

    [LibraryImport("user32.dll")]
    internal static partial uint GetWindowThreadProcessId(nint hWnd, out int lpdwProcessId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    internal static partial nint OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageNameW(nint hProcess, uint dwFlags, [Out] char[] lpExeName, ref int lpdwSize);
}
