using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Agent.Native.Interop;

namespace Agent.Native;

public interface IIdleInputMonitor
{
    /// <summary>
    /// Time since the last keyboard/mouse/pen/touch input in the calling process's session.
    /// Must be called from an interactive session (Session 0 services get no meaningful signal).
    /// </summary>
    TimeSpan GetIdleDuration();
}

[SupportedOSPlatform("windows")]
public sealed class IdleInputMonitor : IIdleInputMonitor
{
    public TimeSpan GetIdleDuration()
    {
        var info = new NativeMethods.LASTINPUTINFO
        {
            cbSize = (uint)Marshal.SizeOf<NativeMethods.LASTINPUTINFO>()
        };

        if (!NativeMethods.GetLastInputInfo(ref info))
        {
            throw new InvalidOperationException(
                $"GetLastInputInfo failed with Win32 error {Marshal.GetLastWin32Error()}.");
        }

        // GetLastInputInfo's dwTime is tied to the 32-bit GetTickCount() timer by contract
        // (Microsoft Learn), which wraps every ~49.7 days. Unsigned subtraction wraps
        // identically, so this stays correct across a single rollover.
        var idleMilliseconds = unchecked((uint)Environment.TickCount - info.dwTime);
        return TimeSpan.FromMilliseconds(idleMilliseconds);
    }
}
