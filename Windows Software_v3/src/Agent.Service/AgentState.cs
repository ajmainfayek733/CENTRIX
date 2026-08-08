using Agent.Core.Policy;

namespace Agent.Service;

/// <summary>
/// Runtime state shared between the service's workers and its IPC server.
///
/// Registered as a singleton. Reads happen on every collector message and writes only when
/// policy or connectivity changes, so the policy reference is swapped atomically rather than
/// guarded by a lock: <see cref="AgentPolicy"/> is an immutable record, so a reader either sees
/// the whole old document or the whole new one, never a half-applied mix.
/// </summary>
public sealed class AgentState
{
    private volatile AgentPolicy _policy = new();
    private volatile string? _activeUserSid;

    /// <summary>
    /// The policy in force. Starts at the Features.md defaults so collection begins at boot
    /// rather than waiting for the first successful fetch.
    /// </summary>
    public AgentPolicy Policy
    {
        get => _policy;
        private set => _policy = value;
    }

    /// <summary>SID of the user on the interactive desktop, learned from the host's hello.</summary>
    public string? ActiveUserSid
    {
        get => _activeUserSid;
        set => _activeUserSid = value;
    }

    /// <summary>Whether the last backend call succeeded. Drives the host's status indicator.</summary>
    public bool BackendReachable { get; set; }

    /// <summary>Whether the device holds a working API key.</summary>
    public bool Enrolled { get; set; }

    /// <summary>
    /// Set when an admin deactivates this device. The sync worker stops uploading, but
    /// collection continues locally — re-activating the device should not leave a hole in the
    /// record for the period it was switched off.
    /// </summary>
    public bool Deactivated { get; set; }

    /// <summary>Raised after a policy swap so the IPC server can push it to the host.</summary>
    public event Action<AgentPolicy, bool>? PolicyChanged;

    /// <summary>
    /// Applies a newly fetched policy. Returns true when the version actually moved, which is
    /// what triggers a fresh consent prompt on the desktop (spec section 3).
    /// </summary>
    public bool ApplyPolicy(AgentPolicy policy)
    {
        var previousVersion = _policy.Version;
        Policy = policy;

        var versionChanged = policy.Version != previousVersion;
        PolicyChanged?.Invoke(policy, versionChanged);
        return versionChanged;
    }
}
