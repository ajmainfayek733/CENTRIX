namespace Agent.Core.Policy;

/// <summary>
/// A single immutable, versioned snapshot of every admin-controlled setting. Collectors never
/// read individual settings directly from config — they read the current snapshot via
/// <see cref="IPolicyProvider"/> so a policy update is atomic across the whole agent.
/// </summary>
public sealed record PolicyDocument
{
    public required int Version { get; init; }

    public AttendancePolicy Attendance { get; init; } = new();

    public ActivityPolicy Activity { get; init; } = new();

    public AppSessionPolicy AppSession { get; init; } = new();

    public BrowserMonitorPolicy BrowserMonitor { get; init; } = new();

    public ScreenshotPolicy Screenshot { get; init; } = new();

    public UsbPolicy Usb { get; init; } = new();

    public AlertPolicy Alert { get; init; } = new();

    public SyncPolicy Sync { get; init; } = new();

    public RetentionPolicy Retention { get; init; } = new();

    public WorkingHoursPolicy WorkingHours { get; init; } = new();

    public IReadOnlyDictionary<string, string> ProductivityTags { get; init; } =
        new Dictionary<string, string>();

    public static PolicyDocument Default { get; } = new() { Version = 0 };
}
