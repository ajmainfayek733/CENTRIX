using System;

namespace Agent.Core
{
    public record ActivityLog(
        string DeviceId,
        string? AppName,
        string? WindowTitle,
        string? Domain,
        bool IsIdle,
        int ActivityScore,
        DateTimeOffset CapturedAt
    );

    public record AttendanceRecord(
        string DeviceId,
        DateOnly Date,
        DateTimeOffset FirstLogin,
        DateTimeOffset? LastLogout,
        long TotalActiveSeconds
    );

    public record ScreenshotRecord(
        string DeviceId,
        DateTimeOffset CapturedAt,
        byte[] EncryptedImageData
    );

    public record UsbDeviceRecord(
        string DeviceId,
        string DeviceName,
        string Action, // "Connected" or "Disconnected"
        DateTimeOffset CapturedAt
    );

    public record QueuedRecord<T>(
        long LocalId,
        T Payload,
        bool Synced,
        int Attempts,
        DateTimeOffset? LastAttemptAt
    );

    public record AgentSettings(
        bool AppTrackingEnabled,
        bool UrlTrackingEnabled,
        bool IdleDetectionEnabled,
        int IdleThresholdSeconds,
        bool AttendanceEnabled,
        bool ScreenshotsEnabled,
        int ScreenshotIntervalMinutes,
        bool ActivityLevelEnabled,
        bool UsbLoggingEnabled,
        int SampleIntervalSeconds,
        int SyncIntervalSeconds
    )
    {
        // Default constructor with sensible default values
        public AgentSettings() : this(
            AppTrackingEnabled: true,
            UrlTrackingEnabled: false, // Phase 2
            IdleDetectionEnabled: true,
            IdleThresholdSeconds: 300, // 5 minutes
            AttendanceEnabled: true,
            ScreenshotsEnabled: false, // Off by default
            ScreenshotIntervalMinutes: 10,
            ActivityLevelEnabled: true,
            UsbLoggingEnabled: false, // Phase 3
            SampleIntervalSeconds: 15,
            SyncIntervalSeconds: 60 // 1 minute
        ) {}
    }

    public record IngestBatch(
        string DeviceId,
        ActivityLog[] ActivityLogs,
        ScreenshotRecord[] Screenshots,
        UsbDeviceRecord[] UsbLogs,
        AttendanceRecord[] AttendanceRecords
    );
}
