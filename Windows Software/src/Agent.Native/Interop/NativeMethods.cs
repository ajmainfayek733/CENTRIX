using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Agent.Native.Interop;

/// <summary>
/// Raw P/Invoke declarations only - no business logic. See Microsoft Learn:
/// GetLastInputInfo (https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getlastinputinfo),
/// WTSQuerySessionInformation (https://learn.microsoft.com/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw).
/// </summary>
[SupportedOSPlatform("windows")]
internal static partial class NativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    internal enum WTS_INFO_CLASS
    {
        WTSUserName = 5,
        WTSDomainName = 7,
        WTSClientProtocolType = 16
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [LibraryImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool WTSQuerySessionInformation(
        nint hServer,
        int sessionId,
        WTS_INFO_CLASS wtsInfoClass,
        out nint ppBuffer,
        out uint pBytesReturned);

    [LibraryImport("wtsapi32.dll")]
    internal static partial void WTSFreeMemory(nint pMemory);

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool WTSQueryUserToken(int sessionId, out nint phToken);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool CloseHandle(nint hObject);

    [LibraryImport("kernel32.dll")]
    internal static partial uint WTSGetActiveConsoleSessionId();
}
