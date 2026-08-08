using System.Text.Json.Serialization;
using Agent.Core.Contracts;
using Agent.Core.Policy;

namespace Agent.Core.Ipc;

/// <summary>
/// Messages exchanged over the named pipe between the SYSTEM service and the per-user host.
///
/// The split follows what each side can actually do: only the host can read the foreground
/// window, idle time or capture the screen (session 0 cannot), and only the service holds the
/// device credential and the database. So the host produces observations and the service
/// decides what to store and send.
///
/// Serialized polymorphically on a "$type" discriminator so a version mismatch between the two
/// executables surfaces as an unknown-type failure rather than a silently misparsed payload.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "$type")]
[JsonDerivedType(typeof(HelloMessage), "hello")]
[JsonDerivedType(typeof(HelloAckMessage), "hello-ack")]
[JsonDerivedType(typeof(PingMessage), "ping")]
[JsonDerivedType(typeof(SubmitAttendanceMessage), "submit-attendance")]
[JsonDerivedType(typeof(SubmitActivityMetricMessage), "submit-activity-metric")]
[JsonDerivedType(typeof(SubmitActivitySessionMessage), "submit-activity-session")]
[JsonDerivedType(typeof(SubmitBrowserActivityMessage), "submit-browser-activity")]
[JsonDerivedType(typeof(SubmitAlertMessage), "submit-alert")]
[JsonDerivedType(typeof(SubmitScreenshotMessage), "submit-screenshot")]
[JsonDerivedType(typeof(ConsentAcknowledgedMessage), "consent-acknowledged")]
[JsonDerivedType(typeof(PolicyUpdatedMessage), "policy-updated")]
[JsonDerivedType(typeof(ShowNotificationMessage), "show-notification")]
[JsonDerivedType(typeof(RequestScreenshotMessage), "request-screenshot")]
[JsonDerivedType(typeof(ShutdownMessage), "shutdown")]
public abstract record IpcMessage;

// -- Host -> Service ---------------------------------------------------------

/// <summary>First message on every connection: tells the service who is on this desktop.</summary>
public sealed record HelloMessage : IpcMessage
{
    public required string UserSid { get; init; }
    public required string UserName { get; init; }
    public required int WindowsSessionId { get; init; }
    public required string HostVersion { get; init; }
}

public sealed record SubmitAttendanceMessage : IpcMessage
{
    public required AttendanceEvent Event { get; init; }
}

public sealed record SubmitActivityMetricMessage : IpcMessage
{
    public required ActivityMetricEvent Event { get; init; }
}

public sealed record SubmitActivitySessionMessage : IpcMessage
{
    public required ActivitySessionEvent Event { get; init; }
}

public sealed record SubmitBrowserActivityMessage : IpcMessage
{
    public required BrowserActivityEvent Event { get; init; }
}

public sealed record SubmitAlertMessage : IpcMessage
{
    public required AlertEvent Event { get; init; }
}

/// <summary>
/// The host captures the screen and writes the JPEG to the shared spool directory, then sends
/// only the path. Image bytes never travel through the pipe — a 1–3 MB frame every ten minutes
/// would dominate the channel that also carries time-sensitive activity events.
/// </summary>
public sealed record SubmitScreenshotMessage : IpcMessage
{
    public required Guid ClientEventId { get; init; }
    public required string UserSid { get; init; }
    public required DateTimeOffset CapturedAt { get; init; }
    public required string FilePath { get; init; }
    public required long SizeBytes { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
}

/// <summary>Employee acknowledged the monitoring notice for a given policy version (spec section 3).</summary>
public sealed record ConsentAcknowledgedMessage : IpcMessage
{
    public required string UserSid { get; init; }
    public required int PolicyVersion { get; init; }
    public required DateTimeOffset AcknowledgedAt { get; init; }
}

// -- Service -> Host ---------------------------------------------------------

public sealed record HelloAckMessage : IpcMessage
{
    public required AgentPolicy Policy { get; init; }
    public required bool ConsentRequired { get; init; }
    public required bool BackendReachable { get; init; }
}

public sealed record PolicyUpdatedMessage : IpcMessage
{
    public required AgentPolicy Policy { get; init; }
    /// <summary>True when the version changed such that the employee must re-acknowledge.</summary>
    public bool ConsentRequired { get; init; }
}

/// <summary>Desktop notification the host should raise (Features.md "Alert Notification").</summary>
public sealed record ShowNotificationMessage : IpcMessage
{
    public required string Title { get; init; }
    public required string Message { get; init; }
    public required AlertSeverity Severity { get; init; }
}

public sealed record RequestScreenshotMessage : IpcMessage;

public sealed record ShutdownMessage : IpcMessage
{
    public string? Reason { get; init; }
}

// -- Either direction --------------------------------------------------------

public sealed record PingMessage : IpcMessage
{
    public DateTimeOffset SentAt { get; init; } = DateTimeOffset.UtcNow;
}
