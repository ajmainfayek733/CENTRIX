using System.Runtime.Versioning;
using System.Security.Principal;

namespace Agent.Native;

/// <summary>
/// For a process to report its own identity — unlike <see cref="IWtsSessionInfoProvider"/>,
/// which queries an arbitrary session's user via WTSQueryUserToken and requires the
/// SE_TCB_NAME privilege (held by LocalSystem, not a normal interactive process). The tray
/// helper always runs as the interactive user already, so it never needs that privileged
/// lookup — it can just ask for its own identity.
/// </summary>
public interface ICurrentUserProvider
{
    string GetCurrentUserSid();
}

[SupportedOSPlatform("windows")]
public sealed class CurrentUserProvider : ICurrentUserProvider
{
    public string GetCurrentUserSid() => WindowsIdentity.GetCurrent().User?.Value ?? string.Empty;
}
