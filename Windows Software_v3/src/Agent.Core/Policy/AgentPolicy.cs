using Agent.Core.Contracts;

namespace Agent.Core.Policy;

/// <summary>
/// The policy document served by <c>GET /api/v1/policy</c>, mirroring the backend's
/// <c>AgentPolicyDto</c>. Always the full document, never a diff.
///
/// The defaults on every property matter: they are what the agent runs on before its first
/// successful policy fetch, and Features.md's "activity data is persisted locally ... to ensure
/// data integrity across restarts" means collection must start immediately rather than block on
/// the network.
/// </summary>
public sealed record AgentPolicy
{
    /// <summary>
    /// Incremented by the backend on every policy write. The agent re-prompts for consent when
    /// this changes, so it must never be ignored.
    /// </summary>
    public int Version { get; init; } = 1;

    public AttendancePolicy Attendance { get; init; } = new();
    public ActivityPolicy Activity { get; init; } = new();
    public AppSessionPolicy AppSession { get; init; } = new();
    public BrowserMonitorPolicy BrowserMonitor { get; init; } = new();
    public ScreenshotPolicy Screenshot { get; init; } = new();
    public UsbPolicy Usb { get; init; } = new();
    public AlertPolicy Alert { get; init; } = new();
    public SyncPolicy Sync { get; init; } = new();
    public RealtimePolicy Realtime { get; init; } = new();
    public RetentionPolicy Retention { get; init; } = new();
    public WorkingHoursPolicy WorkingHours { get; init; } = new();

    /// <summary>
    /// Productivity and blacklist rules, flattened from the backend's categories table so the
    /// agent can raise a local notification without a round trip.
    /// </summary>
    public List<CategoryRule> Categories { get; init; } = [];
}

public sealed record AttendancePolicy
{
    public bool Enabled { get; init; } = true;
}

public sealed record ActivityPolicy
{
    public bool Enabled { get; init; } = true;

    /// <summary>Features.md "Activity Logs": default 5-minute idle threshold.</summary>
    public int IdleThresholdSeconds { get; init; } = 300;
}

public sealed record AppSessionPolicy
{
    public bool Enabled { get; init; } = true;
    public int PollSeconds { get; init; } = 1;
}

public sealed record BrowserMonitorPolicy
{
    public bool Enabled { get; init; } = true;
    public int UiaTimeoutMs { get; init; } = 500;
    public int MaxRetryAttempts { get; init; } = 3;
}

public sealed record ScreenshotPolicy
{
    /// <summary>
    /// Features.md: enabled by default while testing, flipped off before publish. Spec section 4
    /// requires it be fully toggleable by an admin, which is what this flag is.
    /// </summary>
    public bool Enabled { get; init; } = true;

    public int IntervalSeconds { get; init; } = 600;
    public int JpegQuality { get; init; } = 70;
}

public sealed record UsbPolicy
{
    public bool Enabled { get; init; } = true;
    public int ReconciliationIntervalSeconds { get; init; } = 5;
    public bool AlertOnInsertion { get; init; }
}

public sealed record AlertPolicy
{
    public bool Enabled { get; init; } = true;
    public IdleAlertPolicy Idle { get; init; } = new();
    public bool BlacklistEnabled { get; init; } = true;
    public bool NotifyOutsideWorkingHours { get; init; }
}

/// <summary>Features.md "Alert Notification": 30 min Normal, 45 min Moderate, 60 min Severe.</summary>
public sealed record IdleAlertPolicy
{
    public bool Enabled { get; init; } = true;
    public int NormalSeconds { get; init; } = 1800;
    public int ModerateSeconds { get; init; } = 2700;
    public int SevereSeconds { get; init; } = 3600;
    public int RenotifySeconds { get; init; } = 900;
}

public sealed record SyncPolicy
{
    public int BatchIntervalSeconds { get; init; } = 120;

    /// <summary>
    /// Events per push. Matches the backend's policy default: batch size is the main lever on
    /// peak server cost, and a fleet draining a backlog together multiplies whatever this is.
    /// Admins change it from the settings screen — the agent never hardcodes a size.
    /// </summary>
    public int MaxBatchSize { get; init; } = 100;

    public int MinRetryBackoffSeconds { get; init; } = 5;
    public int MaxRetryBackoffSeconds { get; init; } = 120;
}

/// <summary>
/// Whether the agent holds a Socket.IO signalling connection.
///
/// Signalling only. The agent syncs on its own interval and gates that on the HTTP heartbeat
/// whether or not this is on — turning it off costs promptness, never data.
/// </summary>
public sealed record RealtimePolicy
{
    public bool Enabled { get; init; } = true;
}

public sealed record RetentionPolicy
{
    public int RetentionDays { get; init; } = 90;
    public int UndeliveredRetentionDays { get; init; } = 30;
}

public sealed record WorkingHoursPolicy
{
    public string StartLocal { get; init; } = "08:00";
    public string EndLocal { get; init; } = "17:00";
    public List<string> WorkingDays { get; init; } = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
}

public sealed record CategoryRule
{
    public required string Pattern { get; init; }
    public required CategoryTarget Target { get; init; }
    public ProductivityTag Tag { get; init; } = ProductivityTag.Neutral;
    public bool IsBlacklisted { get; init; }
}
