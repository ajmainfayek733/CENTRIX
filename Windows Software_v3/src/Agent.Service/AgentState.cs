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
public sealed class AgentState : IDisposable
{
    private volatile AgentPolicy _policy = new();
    private volatile string? _activeUserSid;

    /// <summary>
    /// Wake-up signals from the realtime channel to the workers that own the actual work.
    ///
    /// Each is a semaphore capped at one permit, which coalesces on purpose: ten force-sync
    /// commands arriving while a sync is already running should produce one more cycle, not ten
    /// queued ones. A worker waits on its signal *instead of* sleeping, so a nudge shortens the
    /// current wait rather than adding a second timer racing the first — no extra thread, and
    /// nothing to leak if the signal never comes.
    /// </summary>
    private readonly SemaphoreSlim _syncRequested = new(0, 1);
    private readonly SemaphoreSlim _policyRefreshRequested = new(0, 1);

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

    // -----------------------------------------------------------------------
    // Wake-up signals.
    //
    // NOTE FOR ANYONE ADDING A CALLER: requesting a sync is a request to try *sooner*, not an
    // assertion that the backend is available. Nothing here may set BackendReachable — that is
    // decided by the HTTP heartbeat, and only by it.
    // -----------------------------------------------------------------------

    /// <summary>Asks the sync worker to drain the queue now instead of waiting out its interval.</summary>
    public void RequestSync() => Signal(_syncRequested);

    /// <summary>Asks the connectivity worker to re-read policy now.</summary>
    public void RequestPolicyRefresh() => Signal(_policyRefreshRequested);

    /// <summary>
    /// Waits for a sync request, or for <paramref name="timeout"/> to elapse.
    /// </summary>
    /// <returns>True when a request arrived, false when the normal interval simply expired.</returns>
    public Task<bool> WaitForSyncRequestAsync(TimeSpan timeout, CancellationToken ct) =>
        _syncRequested.WaitAsync(timeout, ct);

    /// <summary>Waits for a policy-refresh request, or for <paramref name="timeout"/> to elapse.</summary>
    public Task<bool> WaitForPolicyRefreshAsync(TimeSpan timeout, CancellationToken ct) =>
        _policyRefreshRequested.WaitAsync(timeout, ct);

    /// <summary>
    /// Releases a permit unless one is already pending.
    ///
    /// The count is checked rather than catching <see cref="SemaphoreFullException"/>: a burst of
    /// commands is entirely normal traffic, and using exceptions for it would fill the log with
    /// stack traces describing correct behaviour.
    ///
    /// Locked because check-then-release is not atomic on its own: two callers could both observe
    /// an empty semaphore and both release, which is exactly the exception the check exists to
    /// avoid. The semaphore instance is private and never handed out, so it is safe to lock on.
    /// </summary>
    private static void Signal(SemaphoreSlim semaphore)
    {
        lock (semaphore)
        {
            if (semaphore.CurrentCount == 0) semaphore.Release();
        }
    }

    public void Dispose()
    {
        _syncRequested.Dispose();
        _policyRefreshRequested.Dispose();
    }
}
