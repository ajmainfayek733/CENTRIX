using System.Text.Json.Serialization;

namespace Agent.Core.Contracts;

// These enums are the client half of the backend's Postgres enums. The names must match the
// backend's `ingest.dto.ts` exactly - they are serialized as strings and the server rejects
// anything outside its own enum. A rename here is a two-repo commit.

/// <summary>Features.md "Activity Logs" -> Type.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ActivityType>))]
public enum ActivityType
{
    Application,
    Desktop,
    Locked,
    Idle,
    Sleeping,
    Disconnected
}

/// <summary>Why a foreground-activity session ended.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ActivityEndReason>))]
public enum ActivityEndReason
{
    UserInactivity,
    ScreenLock,
    Sleep,
    Disconnect,
    AppSwitch,
    SessionEnd
}

[JsonConverter(typeof(JsonStringEnumConverter<ProductivityTag>))]
public enum ProductivityTag
{
    Productive,
    Unproductive,
    Blacklisted,
    Neutral
}

/// <summary>
/// Why an attendance session's logout time was stamped. Covers the lock/shutdown/hibernate/
/// power-loss cases Features.md calls out for the attendance report.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<SessionEndReason>))]
public enum SessionEndReason
{
    Logout,
    Lock,
    Shutdown,
    Restart,
    Hibernate,
    Sleep,
    PowerLoss,
    Disconnect,

    /// <summary>
    /// The session was still open when the agent restarted, so the logout time is the last
    /// heartbeat we managed to persist rather than an observed logoff.
    /// </summary>
    Recovered
}

[JsonConverter(typeof(JsonStringEnumConverter<UsbEventType>))]
public enum UsbEventType
{
    Connected,
    Disconnected
}

[JsonConverter(typeof(JsonStringEnumConverter<UsbDeviceType>))]
public enum UsbDeviceType
{
    UsbStorage,
    MobileDevice,
    Hid,
    Other
}

[JsonConverter(typeof(JsonStringEnumConverter<BrowserKind>))]
public enum BrowserKind
{
    Chrome,
    Edge,
    Firefox,
    Brave,
    Opera,
    Vivaldi,
    Other
}

[JsonConverter(typeof(JsonStringEnumConverter<UrlProtocol>))]
public enum UrlProtocol
{
    Http,
    Https
}

[JsonConverter(typeof(JsonStringEnumConverter<AlertSeverity>))]
public enum AlertSeverity
{
    Information,
    Warning,
    High,
    Critical
}

[JsonConverter(typeof(JsonStringEnumConverter<AlertState>))]
public enum AlertState
{
    New,
    Shown,
    Acknowledged,
    Resolved,
    Archived
}

[JsonConverter(typeof(JsonStringEnumConverter<AlertType>))]
public enum AlertType
{
    IdleThreshold,
    BlacklistedApp,
    BlacklistedWebsite,
    UsbDeviceConnected
}

/// <summary>Whether a category rule matches an application or a web domain.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<CategoryTarget>))]
public enum CategoryTarget
{
    Application,
    Domain
}

/// <summary>
/// The telemetry channels, matching the <c>POST /api/v1/events/{channel}</c> path segment.
/// The string values are the wire names; the enum names are the C# ones.
/// </summary>
public enum TelemetryChannel
{
    Attendance,
    ActivityMetric,
    ActivitySession,
    BrowserActivity,
    UsbEvent,
    Alert
}

public static class TelemetryChannelExtensions
{
    /// <summary>The URL path segment for a channel, e.g. <c>activity-session</c>.</summary>
    public static string ToWireName(this TelemetryChannel channel) => channel switch
    {
        TelemetryChannel.Attendance => "attendance",
        TelemetryChannel.ActivityMetric => "activity-metric",
        TelemetryChannel.ActivitySession => "activity-session",
        TelemetryChannel.BrowserActivity => "browser-activity",
        TelemetryChannel.UsbEvent => "usb-event",
        TelemetryChannel.Alert => "alert",
        _ => throw new ArgumentOutOfRangeException(nameof(channel), channel, "Unknown telemetry channel")
    };
}
