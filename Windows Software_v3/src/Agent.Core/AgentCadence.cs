namespace Agent.Core;

/// <summary>
/// Timings that both halves of the agent have to agree on.
///
/// These live here rather than next to the code that uses them because each one is a contract
/// between the two processes: the host writes on a cadence, and the service draws conclusions from
/// how long it has been since it last saw a write. A constant duplicated on both sides would let
/// them drift apart, and the failure that produces is silent - the service would simply start
/// reaching the wrong conclusion.
/// </summary>
public static class AgentCadence
{
    /// <summary>
    /// How often the host refreshes the open attendance row.
    ///
    /// Frequent enough that an unexpected power loss loses at most this much of the day, cheap
    /// enough not to matter - it is an upsert on one row.
    /// </summary>
    public static readonly TimeSpan AttendanceFlush = TimeSpan.FromMinutes(2);

    /// <summary>
    /// How long an open attendance row may go unrefreshed before the service concludes the host
    /// that owned it is gone and closes the session.
    ///
    /// Derived from the flush interval rather than chosen independently, and deliberately several
    /// times larger. A live session rewrites its row on every flush, so anything older than this
    /// belongs to a host that is no longer running - but a workstation under heavy load, or one
    /// whose service was stopped for a few minutes during an upgrade, must never be mistaken for a
    /// dead session and have a logout time stamped on it while the employee is still working.
    /// </summary>
    public static readonly TimeSpan AttendanceStale = AttendanceFlush * StaleFlushMultiple;

    private const int StaleFlushMultiple = 7;
}
