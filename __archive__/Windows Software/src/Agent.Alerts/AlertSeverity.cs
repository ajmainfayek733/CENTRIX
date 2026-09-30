namespace Agent.Alerts;

/// <summary>Declared in ascending order - comparisons (e.g. "is this an escalation?") rely on
/// the enum's ordinal value increasing with severity.</summary>
public enum AlertSeverity
{
    Information,
    Warning,
    High,
    Critical
}

public enum AlertType
{
    IdleWarning,
    ExcessiveIdle,
    BlacklistedWebsite,
    RestrictedApplication,
    OutsideWorkingHours,
    ScreenshotFailure,
    UsbViolation,
    ServiceFailure,
    SyncFailure,
    PolicyViolation,
    SuspiciousActivity
}

public enum AlertState
{
    New,
    Shown,
    Acknowledged,
    Resolved,
    Archived
}
