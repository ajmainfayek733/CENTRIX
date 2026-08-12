using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Agent.Native.Interop;

namespace Agent.Native;

public interface IWtsSessionInfoProvider
{
    /// <summary>Requires SE_TCB_NAME privilege (held by LocalSystem). Returns null if unavailable.</summary>
    string? TryGetUserSid(int sessionId);

    bool IsRemoteSession(int sessionId);

    /// <summary>The session ID of the currently active console session (Microsoft Learn:
    /// WTSGetActiveConsoleSessionId), used to attribute machine-scoped events like USB
    /// insertions to whichever user is currently active.</summary>
    int GetActiveConsoleSessionId();
}

[SupportedOSPlatform("windows")]
public sealed class WtsSessionInfoProvider : IWtsSessionInfoProvider
{
    public string? TryGetUserSid(int sessionId)
    {
        if (!NativeMethods.WTSQueryUserToken(sessionId, out var tokenHandle))
        {
            return null;
        }

        try
        {
            using var identity = new WindowsIdentity(tokenHandle);
            return identity.User?.Value;
        }
        finally
        {
            NativeMethods.CloseHandle(tokenHandle);
        }
    }

    public bool IsRemoteSession(int sessionId)
    {
        if (!NativeMethods.WTSQuerySessionInformation(
                nint.Zero,
                sessionId,
                NativeMethods.WTS_INFO_CLASS.WTSClientProtocolType,
                out var buffer,
                out _))
        {
            return false;
        }

        try
        {
            // WTS_INFO_CLASS.WTSClientProtocolType: 0 = Console, 1 = ICA, 2 = RDP (Microsoft Learn).
            var protocolType = Marshal.ReadInt16(buffer);
            return protocolType == 2;
        }
        finally
        {
            NativeMethods.WTSFreeMemory(buffer);
        }
    }

    public int GetActiveConsoleSessionId() => (int)NativeMethods.WTSGetActiveConsoleSessionId();
}
