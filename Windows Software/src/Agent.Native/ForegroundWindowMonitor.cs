using System.Runtime.Versioning;
using Agent.Native.Interop;

namespace Agent.Native;

/// <summary>
/// Implements the exact chain the App Session spec calls for: GetForegroundWindow ->
/// GetWindowThreadProcessId -> OpenProcess -> QueryFullProcessImageNameW -> GetWindowText.
/// Uses PROCESS_QUERY_LIMITED_INFORMATION (least privilege) rather than PROCESS_ALL_ACCESS.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ForegroundWindowMonitor : IForegroundWindowMonitor
{
    public ForegroundWindowSnapshot? GetCurrentForegroundWindow()
    {
        var hwnd = NativeMethods.GetForegroundWindow();
        if (hwnd == nint.Zero)
        {
            return null;
        }

        NativeMethods.GetWindowThreadProcessId(hwnd, out var processId);
        if (processId == 0)
        {
            return null;
        }

        var executablePath = TryGetExecutablePath(processId);
        if (executablePath is null)
        {
            // Elevated process while the agent is not (or vice versa), or the process has
            // already exited between the two calls - a documented, expected race.
            return null;
        }

        var windowTitle = TryGetWindowTitle(hwnd);
        return new ForegroundWindowSnapshot(hwnd, processId, executablePath, windowTitle);
    }

    private static string? TryGetExecutablePath(int processId)
    {
        var handle = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == nint.Zero)
        {
            return null;
        }

        try
        {
            var buffer = new char[4096];
            var size = buffer.Length;
            return NativeMethods.QueryFullProcessImageNameW(handle, 0, buffer, ref size)
                ? new string(buffer, 0, size)
                : null;
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static string TryGetWindowTitle(nint hwnd)
    {
        var buffer = new char[1024];
        var copied = NativeMethods.GetWindowTextW(hwnd, buffer, buffer.Length);
        return copied <= 0 ? string.Empty : new string(buffer, 0, copied);
    }
}
