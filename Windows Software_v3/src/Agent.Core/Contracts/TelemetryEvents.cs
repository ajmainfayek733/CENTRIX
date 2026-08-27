namespace Agent.Core.Contracts;

/// <summary>
/// Wire DTOs for <c>POST /api/v1/events/{channel}</c>. Property names serialize to camelCase
/// (see <see cref="AgentJson"/>) and mirror the backend's Zod schemas field for field.
///
/// Every event carries a client-generated <c>ClientEventId</c>: sync is at-least-once, so a
/// batch whose HTTP response was lost is resent verbatim and the server deduplicates on that id.
/// </summary>
public interface ITelemetryEvent
{
    Guid ClientEventId { get; }
}

/// <summary>Features.md "Attendace report" - one per Windows logon session.</summary>
public sealed record AttendanceEvent : ITelemetryEvent
{
    public required Guid ClientEventId { get; init; }
    public required Guid SessionId { get; init; }

    /// <summary>
    /// Which snapshot of this session this is: 1 for the row as it was first written, bumped on
    /// every rewrite of it. One session is reported many times - open with no seconds on it, open
    /// with thirty seconds, closed - and the queue is at-least-once over a link that can be down for
    /// hours, so the server sees these out of order and cannot tell a newer report from a
    /// redelivered older one by looking at it. This is that answer, stated rather than inferred.
    /// Assigned by <see cref="Storage.TelemetryQueue"/> on write, never by a caller.
    /// </summary>
    public int Revision { get; init; }

    public required string UserSid { get; init; }
    public required DateTimeOffset LoginTime { get; init; }
    public DateTimeOffset? LogoutTime { get; init; }
    public SessionEndReason? EndReason { get; init; }

    /// <summary>Local calendar date (yyyy-MM-dd). Only the workstation knows its own timezone.</summary>
    public required string WorkDate { get; init; }

    public int TotalActiveSeconds { get; init; }
    public int TotalIdleSeconds { get; init; }
}

/// <summary>
/// Features.md "Activity Level Metric".
///
/// PRIVACY: counts only. There is deliberately no field on this type that could carry a key,
/// a character or a sequence - spec section 1.2 and section 6 exclude keystroke content, and the
/// collector increments these counters without ever inspecting the virtual key code.
/// </summary>
public sealed record ActivityMetricEvent : ITelemetryEvent
{
    public required Guid ClientEventId { get; init; }
    public required Guid SessionId { get; init; }

    public int KeyCount { get; init; }
    public int MouseCount { get; init; }
    public int MouseLeftKeyCount { get; init; }
    public int MouseRightKeyCount { get; init; }
    public int MouseMiddleKeyCount { get; init; }
    public int MouseOtherKeyCount { get; init; }

    public required DateTimeOffset WindowStartUtc { get; init; }
    public required DateTimeOffset WindowEndUtc { get; init; }
}

/// <summary>Features.md "Activity Logs" - one per foreground app, idle, lock or sleep interval.</summary>
public sealed record ActivitySessionEvent : ITelemetryEvent
{
    public required Guid ClientEventId { get; init; }
    public required Guid ActivitySessionId { get; init; }
    public required Guid SessionId { get; init; }

    public string? AppName { get; init; }
    public string? ProcessName { get; init; }
    public string? ExecutablePath { get; init; }
    public required ActivityType Type { get; init; }
    public string? WindowTitle { get; init; }

    public required DateTimeOffset StartTime { get; init; }
    public required DateTimeOffset EndTime { get; init; }
    public required int DurationSeconds { get; init; }

    public ActivityEndReason? Reason { get; init; }

    /// <summary>
    /// The agent's best guess from its cached policy. The server re-derives this from the
    /// admin's current category rules and only keeps this value when no rule matches.
    /// </summary>
    public ProductivityTag ProductivityTag { get; init; } = ProductivityTag.Neutral;
}

/// <summary>Features.md "Browser Activity log".</summary>
public sealed record BrowserActivityEvent : ITelemetryEvent
{
    public required Guid ClientEventId { get; init; }
    public required Guid BrowserActivityId { get; init; }

    /// <summary>Links the visit to the foreground app session that contained it.</summary>
    public Guid? ActivitySessionId { get; init; }

    public required BrowserKind Browser { get; init; }
    public string? BrowserVersion { get; init; }
    public string? ProfileName { get; init; }

    public required string Domain { get; init; }
    public required string RawUrl { get; init; }
    public string? WindowTitle { get; init; }
    public string? PageTitle { get; init; }
    public UrlProtocol Protocol { get; init; } = UrlProtocol.Https;

    public required DateTimeOffset StartTime { get; init; }
    public required DateTimeOffset EndTime { get; init; }
    public required int DurationSeconds { get; init; }

    public ProductivityTag ProductivityTag { get; init; } = ProductivityTag.Neutral;
}

/// <summary>
/// Features.md "USB Logs". Connection and removal metadata only - the agent never enumerates,
/// reads or copies the contents of a connected device.
/// </summary>
public sealed record UsbEvent : ITelemetryEvent
{
    public required Guid ClientEventId { get; init; }
    public Guid? SessionId { get; init; }

    public required UsbEventType EventType { get; init; }
    public required UsbDeviceType DeviceType { get; init; }

    public string? FriendlyName { get; init; }
    public string? Manufacturer { get; init; }
    public string? Model { get; init; }
    public string? SerialNumber { get; init; }
    public string? VendorId { get; init; }
    public string? ProductId { get; init; }

    public string? DriveLetter { get; init; }
    public string? VolumeLabel { get; init; }

    /// <summary>
    /// Decimal string, not a number: drive capacities exceed JSON's safe integer range and
    /// the backend stores this in a BIGINT column.
    /// </summary>
    public string? CapacityBytes { get; init; }

    public string? FileSystem { get; init; }
    public required DateTimeOffset EventTime { get; init; }
}

/// <summary>
/// Features.md "Alert Notification". An escalating incident reuses one
/// <see cref="ClientEventId"/> across escalations - the server upserts rather than inserts,
/// so the dashboard shows one incident that grew rather than three separate alerts.
/// </summary>
public sealed record AlertEvent : ITelemetryEvent
{
    public required Guid ClientEventId { get; init; }
    public required string UserSid { get; init; }

    public required AlertType Type { get; init; }
    public required AlertSeverity Severity { get; init; }
    public AlertState State { get; init; } = AlertState.New;
    public required string Title { get; init; }
    public required string Message { get; init; }

    // Typed context. Which fields are set depends on Type - see the backend's Alert model.
    public int? IdleSeconds { get; init; }
    public int? ThresholdSeconds { get; init; }
    public string? ContextAppName { get; init; }
    public string? ContextProcessName { get; init; }
    public string? ContextDomain { get; init; }
    public string? ContextUrl { get; init; }
    public string? ContextUsbSerialNumber { get; init; }
    public string? ContextUsbFriendlyName { get; init; }

    public required DateTimeOffset TriggeredAt { get; init; }
    public DateTimeOffset? AcknowledgedAt { get; init; }
    public DateTimeOffset? ResolvedAt { get; init; }
    public DateTimeOffset? LastNotifiedAt { get; init; }

    public int EscalationLevel { get; init; }
    public int NotificationCount { get; init; }
}

/// <summary>Device profile sent at enrollment - Features.md "Device Information".</summary>
public sealed record DeviceRegistration
{
    public required string DeviceId { get; init; }
    public required string DeviceName { get; init; }
    public string? SystemType { get; init; }
    public string? Edition { get; init; }
    public string? Version { get; init; }
    /// <summary>
    /// Nullable on purpose. There are real moments - a service starting before the NIC is up,
    /// a machine whose only adapter is virtual - when no hardware address can be determined,
    /// and the honest answer is "unknown". The previous contract required a string, so those
    /// cases sent 00:00:00:00:00:00 and every such device looked identical in the dashboard
    /// while hiding the fact that detection had failed. The server maps null to a null column.
    /// </summary>
    public string? MacAddress { get; init; }
    public string? AgentVersion { get; init; }
}

public sealed record EnrollmentResponse
{
    public bool Authenticated { get; init; }
    public string? ApiKey { get; init; }
    public string? DeviceId { get; init; }
    public string? EmployeeId { get; init; }
    public string? Error { get; init; }
}

public sealed record HeartbeatResponse
{
    public bool Authenticated { get; init; }
    public string? DeviceId { get; init; }
    public int PolicyVersion { get; init; }
    public DateTimeOffset ServerTimeUtc { get; init; }
}

public sealed record PushEventsResponse
{
    public List<Guid> AcknowledgedEventIds { get; init; } = [];
}
