using Agent.Core.Contracts;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Agent.Core.Storage;

/// <summary>
/// The offline queue. Collectors enqueue typed events here; the sync worker drains them and
/// deletes only what the server acknowledged, which is Features.md's "deleting local copies
/// only after successful synchronization".
///
/// A row's <c>sent_utc</c> is NULL while it is pending. Rows are not deleted at the moment
/// they are acknowledged but marked sent and swept later, so an acknowledgement that races a
/// crash cannot lose an event that was never actually stored server-side.
/// </summary>
public sealed class TelemetryQueue(LocalStore store, ILogger<TelemetryQueue> logger)
{
    private readonly LocalStore _store = store;
    private readonly ILogger<TelemetryQueue> _logger = logger;

    // -------------------------------------------------------------------------
    // Enqueue
    // -------------------------------------------------------------------------

    /// <summary>
    /// Upserted on session id, and re-queued (sent_utc reset to NULL) on every write: an open
    /// session refreshes its running totals every couple of minutes and the server needs each
    /// revision.
    ///
    /// A STAMPED LOGOUT IS FINAL, which is what the <c>WHERE</c> on the conflict clause enforces:
    /// the row is only rewritten while it is still open. The host now closes an attendance session
    /// once and starts a new one when the employee comes back, but this is the layer where getting
    /// it wrong is unrecoverable - the periodic refresh sends a null logout time to mean "still
    /// open", and letting one land on a closed row blanked a logout that had already been reported,
    /// leaving a day of logins with no logouts. A late write is dropped here rather than merged,
    /// because a row that has ended has nothing left to revise.
    ///
    /// EVERY WRITE BUMPS <c>revision</c>, which is the number the server orders these reports by.
    /// It is assigned here rather than by the caller because this statement is the only place that
    /// knows whether a write created the row or rewrote it, and because a counter the collectors
    /// held would restart at 1 whenever the host process did. It is not reset by anything: the row
    /// carries it for as long as the session is open, and <see cref="Purge"/> is what deletes the
    /// row, only once the session has closed and the server has acknowledged it.
    /// </summary>
    public void Enqueue(AttendanceEvent e)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO attendance_sessions (
                session_id, client_event_id, revision, user_sid, login_time, logout_time, end_reason,
                work_date, total_active_seconds, total_idle_seconds, created_utc, sent_utc, attempts
            ) VALUES (
                $sessionId, $clientEventId, 1, $userSid, $loginTime, $logoutTime, $endReason,
                $workDate, $activeSeconds, $idleSeconds, $now, NULL, 0
            )
            ON CONFLICT(session_id) DO UPDATE SET
                revision             = attendance_sessions.revision + 1,
                logout_time          = excluded.logout_time,
                end_reason           = excluded.end_reason,
                total_active_seconds = excluded.total_active_seconds,
                total_idle_seconds   = excluded.total_idle_seconds,
                sent_utc             = NULL,
                attempts             = 0
            WHERE attendance_sessions.logout_time IS NULL;
            """;
        command.Parameters.AddWithValue("$sessionId", e.SessionId.ToString());
        command.Parameters.AddWithValue("$clientEventId", e.ClientEventId.ToString());
        command.Parameters.AddWithValue("$userSid", e.UserSid);
        command.Parameters.AddWithValue("$loginTime", SqlTime.From(e.LoginTime));
        command.Parameters.AddWithValue("$logoutTime", (object?)SqlTime.FromNullable(e.LogoutTime) ?? DBNull.Value);
        command.Parameters.AddWithValue("$endReason", (object?)e.EndReason?.ToString() ?? DBNull.Value);
        command.Parameters.AddWithValue("$workDate", e.WorkDate);
        command.Parameters.AddWithValue("$activeSeconds", e.TotalActiveSeconds);
        command.Parameters.AddWithValue("$idleSeconds", e.TotalIdleSeconds);
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    public void Enqueue(ActivityMetricEvent e)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO activity_metrics (
                client_event_id, session_id, key_count, mouse_count,
                mouse_left_key_count, mouse_right_key_count, mouse_middle_key_count,
                mouse_other_key_count, window_start_utc, window_end_utc, created_utc
            ) VALUES (
                $clientEventId, $sessionId, $keyCount, $mouseCount,
                $left, $right, $middle, $other, $start, $end, $now
            );
            """;
        command.Parameters.AddWithValue("$clientEventId", e.ClientEventId.ToString());
        command.Parameters.AddWithValue("$sessionId", e.SessionId.ToString());
        command.Parameters.AddWithValue("$keyCount", e.KeyCount);
        command.Parameters.AddWithValue("$mouseCount", e.MouseCount);
        command.Parameters.AddWithValue("$left", e.MouseLeftKeyCount);
        command.Parameters.AddWithValue("$right", e.MouseRightKeyCount);
        command.Parameters.AddWithValue("$middle", e.MouseMiddleKeyCount);
        command.Parameters.AddWithValue("$other", e.MouseOtherKeyCount);
        command.Parameters.AddWithValue("$start", SqlTime.From(e.WindowStartUtc));
        command.Parameters.AddWithValue("$end", SqlTime.From(e.WindowEndUtc));
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    public void Enqueue(ActivitySessionEvent e)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO activity_sessions (
                activity_session_id, client_event_id, session_id, app_name, process_name,
                executable_path, type, window_title, start_time, end_time, duration_seconds,
                reason, productivity_tag, created_utc
            ) VALUES (
                $activitySessionId, $clientEventId, $sessionId, $appName, $processName,
                $executablePath, $type, $windowTitle, $startTime, $endTime, $durationSeconds,
                $reason, $tag, $now
            );
            """;
        command.Parameters.AddWithValue("$activitySessionId", e.ActivitySessionId.ToString());
        command.Parameters.AddWithValue("$clientEventId", e.ClientEventId.ToString());
        command.Parameters.AddWithValue("$sessionId", e.SessionId.ToString());
        command.Parameters.AddWithValue("$appName", (object?)e.AppName ?? DBNull.Value);
        command.Parameters.AddWithValue("$processName", (object?)e.ProcessName ?? DBNull.Value);
        command.Parameters.AddWithValue("$executablePath", (object?)e.ExecutablePath ?? DBNull.Value);
        command.Parameters.AddWithValue("$type", e.Type.ToString());
        command.Parameters.AddWithValue("$windowTitle", (object?)e.WindowTitle ?? DBNull.Value);
        command.Parameters.AddWithValue("$startTime", SqlTime.From(e.StartTime));
        command.Parameters.AddWithValue("$endTime", SqlTime.From(e.EndTime));
        command.Parameters.AddWithValue("$durationSeconds", e.DurationSeconds);
        command.Parameters.AddWithValue("$reason", (object?)e.Reason?.ToString() ?? DBNull.Value);
        command.Parameters.AddWithValue("$tag", e.ProductivityTag.ToString());
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    public void Enqueue(BrowserActivityEvent e)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO browser_activity (
                browser_activity_id, client_event_id, activity_session_id, browser,
                browser_version, profile_name, domain, raw_url, window_title, page_title,
                protocol, start_time, end_time, duration_seconds, productivity_tag, created_utc
            ) VALUES (
                $browserActivityId, $clientEventId, $activitySessionId, $browser,
                $browserVersion, $profileName, $domain, $rawUrl, $windowTitle, $pageTitle,
                $protocol, $startTime, $endTime, $durationSeconds, $tag, $now
            );
            """;
        command.Parameters.AddWithValue("$browserActivityId", e.BrowserActivityId.ToString());
        command.Parameters.AddWithValue("$clientEventId", e.ClientEventId.ToString());
        command.Parameters.AddWithValue("$activitySessionId", (object?)e.ActivitySessionId?.ToString() ?? DBNull.Value);
        command.Parameters.AddWithValue("$browser", e.Browser.ToString());
        command.Parameters.AddWithValue("$browserVersion", (object?)e.BrowserVersion ?? DBNull.Value);
        command.Parameters.AddWithValue("$profileName", (object?)e.ProfileName ?? DBNull.Value);
        command.Parameters.AddWithValue("$domain", e.Domain);
        command.Parameters.AddWithValue("$rawUrl", e.RawUrl);
        command.Parameters.AddWithValue("$windowTitle", (object?)e.WindowTitle ?? DBNull.Value);
        command.Parameters.AddWithValue("$pageTitle", (object?)e.PageTitle ?? DBNull.Value);
        command.Parameters.AddWithValue("$protocol", e.Protocol.ToString());
        command.Parameters.AddWithValue("$startTime", SqlTime.From(e.StartTime));
        command.Parameters.AddWithValue("$endTime", SqlTime.From(e.EndTime));
        command.Parameters.AddWithValue("$durationSeconds", e.DurationSeconds);
        command.Parameters.AddWithValue("$tag", e.ProductivityTag.ToString());
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    public void Enqueue(UsbEvent e)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO usb_events (
                client_event_id, session_id, event_type, device_type, friendly_name,
                manufacturer, model, serial_number, vendor_id, product_id, drive_letter,
                volume_label, capacity_bytes, file_system, event_time, created_utc
            ) VALUES (
                $clientEventId, $sessionId, $eventType, $deviceType, $friendlyName,
                $manufacturer, $model, $serialNumber, $vendorId, $productId, $driveLetter,
                $volumeLabel, $capacityBytes, $fileSystem, $eventTime, $now
            );
            """;
        command.Parameters.AddWithValue("$clientEventId", e.ClientEventId.ToString());
        command.Parameters.AddWithValue("$sessionId", (object?)e.SessionId?.ToString() ?? DBNull.Value);
        command.Parameters.AddWithValue("$eventType", e.EventType.ToString());
        command.Parameters.AddWithValue("$deviceType", e.DeviceType.ToString());
        command.Parameters.AddWithValue("$friendlyName", (object?)e.FriendlyName ?? DBNull.Value);
        command.Parameters.AddWithValue("$manufacturer", (object?)e.Manufacturer ?? DBNull.Value);
        command.Parameters.AddWithValue("$model", (object?)e.Model ?? DBNull.Value);
        command.Parameters.AddWithValue("$serialNumber", (object?)e.SerialNumber ?? DBNull.Value);
        command.Parameters.AddWithValue("$vendorId", (object?)e.VendorId ?? DBNull.Value);
        command.Parameters.AddWithValue("$productId", (object?)e.ProductId ?? DBNull.Value);
        command.Parameters.AddWithValue("$driveLetter", (object?)e.DriveLetter ?? DBNull.Value);
        command.Parameters.AddWithValue("$volumeLabel", (object?)e.VolumeLabel ?? DBNull.Value);
        command.Parameters.AddWithValue("$capacityBytes", (object?)e.CapacityBytes ?? DBNull.Value);
        command.Parameters.AddWithValue("$fileSystem", (object?)e.FileSystem ?? DBNull.Value);
        command.Parameters.AddWithValue("$eventTime", SqlTime.From(e.EventTime));
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// Upserted and re-queued: an escalating incident reuses one client event id, and each
    /// escalation must reach the server.
    /// </summary>
    public void Enqueue(AlertEvent e)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO alerts (
                client_event_id, user_sid, type, severity, state, title, message,
                idle_seconds, threshold_seconds, context_app_name, context_process_name,
                context_domain, context_url, context_usb_serial_number, context_usb_friendly_name,
                triggered_at, acknowledged_at, resolved_at, last_notified_at,
                escalation_level, notification_count, created_utc, sent_utc, attempts
            ) VALUES (
                $clientEventId, $userSid, $type, $severity, $state, $title, $message,
                $idleSeconds, $thresholdSeconds, $appName, $processName,
                $domain, $url, $usbSerial, $usbName,
                $triggeredAt, $acknowledgedAt, $resolvedAt, $lastNotifiedAt,
                $escalationLevel, $notificationCount, $now, NULL, 0
            )
            ON CONFLICT(client_event_id) DO UPDATE SET
                severity           = excluded.severity,
                state              = excluded.state,
                title              = excluded.title,
                message            = excluded.message,
                idle_seconds       = excluded.idle_seconds,
                threshold_seconds  = excluded.threshold_seconds,
                acknowledged_at    = excluded.acknowledged_at,
                resolved_at        = excluded.resolved_at,
                last_notified_at   = excluded.last_notified_at,
                escalation_level   = excluded.escalation_level,
                notification_count = excluded.notification_count,
                sent_utc           = NULL,
                attempts           = 0;
            """;
        command.Parameters.AddWithValue("$clientEventId", e.ClientEventId.ToString());
        command.Parameters.AddWithValue("$userSid", e.UserSid);
        command.Parameters.AddWithValue("$type", e.Type.ToString());
        command.Parameters.AddWithValue("$severity", e.Severity.ToString());
        command.Parameters.AddWithValue("$state", e.State.ToString());
        command.Parameters.AddWithValue("$title", e.Title);
        command.Parameters.AddWithValue("$message", e.Message);
        command.Parameters.AddWithValue("$idleSeconds", (object?)e.IdleSeconds ?? DBNull.Value);
        command.Parameters.AddWithValue("$thresholdSeconds", (object?)e.ThresholdSeconds ?? DBNull.Value);
        command.Parameters.AddWithValue("$appName", (object?)e.ContextAppName ?? DBNull.Value);
        command.Parameters.AddWithValue("$processName", (object?)e.ContextProcessName ?? DBNull.Value);
        command.Parameters.AddWithValue("$domain", (object?)e.ContextDomain ?? DBNull.Value);
        command.Parameters.AddWithValue("$url", (object?)e.ContextUrl ?? DBNull.Value);
        command.Parameters.AddWithValue("$usbSerial", (object?)e.ContextUsbSerialNumber ?? DBNull.Value);
        command.Parameters.AddWithValue("$usbName", (object?)e.ContextUsbFriendlyName ?? DBNull.Value);
        command.Parameters.AddWithValue("$triggeredAt", SqlTime.From(e.TriggeredAt));
        command.Parameters.AddWithValue("$acknowledgedAt", (object?)SqlTime.FromNullable(e.AcknowledgedAt) ?? DBNull.Value);
        command.Parameters.AddWithValue("$resolvedAt", (object?)SqlTime.FromNullable(e.ResolvedAt) ?? DBNull.Value);
        command.Parameters.AddWithValue("$lastNotifiedAt", (object?)SqlTime.FromNullable(e.LastNotifiedAt) ?? DBNull.Value);
        command.Parameters.AddWithValue("$escalationLevel", e.EscalationLevel);
        command.Parameters.AddWithValue("$notificationCount", e.NotificationCount);
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    public void EnqueueScreenshot(Guid clientEventId, string? userSid, DateTimeOffset capturedAt,
        string filePath, long sizeBytes, int? width, int? height)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO screenshots (
                client_event_id, user_sid, captured_at, file_path, size_bytes, width, height, created_utc
            ) VALUES ($id, $sid, $capturedAt, $path, $size, $width, $height, $now);
            """;
        command.Parameters.AddWithValue("$id", clientEventId.ToString());
        command.Parameters.AddWithValue("$sid", (object?)userSid ?? DBNull.Value);
        command.Parameters.AddWithValue("$capturedAt", SqlTime.From(capturedAt));
        command.Parameters.AddWithValue("$path", filePath);
        command.Parameters.AddWithValue("$size", sizeBytes);
        command.Parameters.AddWithValue("$width", (object?)width ?? DBNull.Value);
        command.Parameters.AddWithValue("$height", (object?)height ?? DBNull.Value);
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.ExecuteNonQuery();
    }

    // -------------------------------------------------------------------------
    // Dequeue
    // -------------------------------------------------------------------------

    public List<AttendanceEvent> DequeueAttendance(int max) => Query(
        "SELECT * FROM attendance_sessions WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new AttendanceEvent
        {
            ClientEventId = Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            SessionId = Guid.Parse(r.GetString(r.GetOrdinal("session_id"))),
            Revision = r.GetInt32(r.GetOrdinal("revision")),
            UserSid = r.GetString(r.GetOrdinal("user_sid")),
            LoginTime = SqlTime.Parse(r.GetString(r.GetOrdinal("login_time"))),
            LogoutTime = SqlTime.ParseNullable(r.GetNullableString("logout_time")),
            EndReason = ParseNullableEnum<SessionEndReason>(r.GetNullableString("end_reason")),
            WorkDate = r.GetString(r.GetOrdinal("work_date")),
            TotalActiveSeconds = r.GetInt32(r.GetOrdinal("total_active_seconds")),
            TotalIdleSeconds = r.GetInt32(r.GetOrdinal("total_idle_seconds"))
        });

    public List<ActivityMetricEvent> DequeueActivityMetrics(int max) => Query(
        "SELECT * FROM activity_metrics WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new ActivityMetricEvent
        {
            ClientEventId = Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            SessionId = Guid.Parse(r.GetString(r.GetOrdinal("session_id"))),
            KeyCount = r.GetInt32(r.GetOrdinal("key_count")),
            MouseCount = r.GetInt32(r.GetOrdinal("mouse_count")),
            MouseLeftKeyCount = r.GetInt32(r.GetOrdinal("mouse_left_key_count")),
            MouseRightKeyCount = r.GetInt32(r.GetOrdinal("mouse_right_key_count")),
            MouseMiddleKeyCount = r.GetInt32(r.GetOrdinal("mouse_middle_key_count")),
            MouseOtherKeyCount = r.GetInt32(r.GetOrdinal("mouse_other_key_count")),
            WindowStartUtc = SqlTime.Parse(r.GetString(r.GetOrdinal("window_start_utc"))),
            WindowEndUtc = SqlTime.Parse(r.GetString(r.GetOrdinal("window_end_utc")))
        });

    public List<ActivitySessionEvent> DequeueActivitySessions(int max) => Query(
        "SELECT * FROM activity_sessions WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new ActivitySessionEvent
        {
            ClientEventId = Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            ActivitySessionId = Guid.Parse(r.GetString(r.GetOrdinal("activity_session_id"))),
            SessionId = Guid.Parse(r.GetString(r.GetOrdinal("session_id"))),
            AppName = r.GetNullableString("app_name"),
            ProcessName = r.GetNullableString("process_name"),
            ExecutablePath = r.GetNullableString("executable_path"),
            Type = Enum.Parse<ActivityType>(r.GetString(r.GetOrdinal("type"))),
            WindowTitle = r.GetNullableString("window_title"),
            StartTime = SqlTime.Parse(r.GetString(r.GetOrdinal("start_time"))),
            EndTime = SqlTime.Parse(r.GetString(r.GetOrdinal("end_time"))),
            DurationSeconds = r.GetInt32(r.GetOrdinal("duration_seconds")),
            Reason = ParseNullableEnum<ActivityEndReason>(r.GetNullableString("reason")),
            ProductivityTag = Enum.Parse<ProductivityTag>(r.GetString(r.GetOrdinal("productivity_tag")))
        });

    public List<BrowserActivityEvent> DequeueBrowserActivity(int max) => Query(
        "SELECT * FROM browser_activity WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new BrowserActivityEvent
        {
            ClientEventId = Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            BrowserActivityId = Guid.Parse(r.GetString(r.GetOrdinal("browser_activity_id"))),
            ActivitySessionId = ParseNullableGuid(r.GetNullableString("activity_session_id")),
            Browser = Enum.Parse<BrowserKind>(r.GetString(r.GetOrdinal("browser"))),
            BrowserVersion = r.GetNullableString("browser_version"),
            ProfileName = r.GetNullableString("profile_name"),
            Domain = r.GetString(r.GetOrdinal("domain")),
            RawUrl = r.GetString(r.GetOrdinal("raw_url")),
            WindowTitle = r.GetNullableString("window_title"),
            PageTitle = r.GetNullableString("page_title"),
            Protocol = Enum.Parse<UrlProtocol>(r.GetString(r.GetOrdinal("protocol"))),
            StartTime = SqlTime.Parse(r.GetString(r.GetOrdinal("start_time"))),
            EndTime = SqlTime.Parse(r.GetString(r.GetOrdinal("end_time"))),
            DurationSeconds = r.GetInt32(r.GetOrdinal("duration_seconds")),
            ProductivityTag = Enum.Parse<ProductivityTag>(r.GetString(r.GetOrdinal("productivity_tag")))
        });

    public List<UsbEvent> DequeueUsbEvents(int max) => Query(
        "SELECT * FROM usb_events WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new UsbEvent
        {
            ClientEventId = Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            SessionId = ParseNullableGuid(r.GetNullableString("session_id")),
            EventType = Enum.Parse<UsbEventType>(r.GetString(r.GetOrdinal("event_type"))),
            DeviceType = Enum.Parse<UsbDeviceType>(r.GetString(r.GetOrdinal("device_type"))),
            FriendlyName = r.GetNullableString("friendly_name"),
            Manufacturer = r.GetNullableString("manufacturer"),
            Model = r.GetNullableString("model"),
            SerialNumber = r.GetNullableString("serial_number"),
            VendorId = r.GetNullableString("vendor_id"),
            ProductId = r.GetNullableString("product_id"),
            DriveLetter = r.GetNullableString("drive_letter"),
            VolumeLabel = r.GetNullableString("volume_label"),
            CapacityBytes = r.GetNullableString("capacity_bytes"),
            FileSystem = r.GetNullableString("file_system"),
            EventTime = SqlTime.Parse(r.GetString(r.GetOrdinal("event_time")))
        });

    public List<AlertEvent> DequeueAlerts(int max) => Query(
        "SELECT * FROM alerts WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new AlertEvent
        {
            ClientEventId = Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            UserSid = r.GetString(r.GetOrdinal("user_sid")),
            Type = Enum.Parse<AlertType>(r.GetString(r.GetOrdinal("type"))),
            Severity = Enum.Parse<AlertSeverity>(r.GetString(r.GetOrdinal("severity"))),
            State = Enum.Parse<AlertState>(r.GetString(r.GetOrdinal("state"))),
            Title = r.GetString(r.GetOrdinal("title")),
            Message = r.GetString(r.GetOrdinal("message")),
            IdleSeconds = r.GetNullableInt32("idle_seconds"),
            ThresholdSeconds = r.GetNullableInt32("threshold_seconds"),
            ContextAppName = r.GetNullableString("context_app_name"),
            ContextProcessName = r.GetNullableString("context_process_name"),
            ContextDomain = r.GetNullableString("context_domain"),
            ContextUrl = r.GetNullableString("context_url"),
            ContextUsbSerialNumber = r.GetNullableString("context_usb_serial_number"),
            ContextUsbFriendlyName = r.GetNullableString("context_usb_friendly_name"),
            TriggeredAt = SqlTime.Parse(r.GetString(r.GetOrdinal("triggered_at"))),
            AcknowledgedAt = SqlTime.ParseNullable(r.GetNullableString("acknowledged_at")),
            ResolvedAt = SqlTime.ParseNullable(r.GetNullableString("resolved_at")),
            LastNotifiedAt = SqlTime.ParseNullable(r.GetNullableString("last_notified_at")),
            EscalationLevel = r.GetInt32(r.GetOrdinal("escalation_level")),
            NotificationCount = r.GetInt32(r.GetOrdinal("notification_count"))
        });

    public sealed record PendingScreenshot(Guid ClientEventId, string? UserSid, DateTimeOffset CapturedAt,
        string FilePath, int? Width, int? Height);

    public List<PendingScreenshot> DequeueScreenshots(int max) => Query(
        "SELECT * FROM screenshots WHERE sent_utc IS NULL ORDER BY created_utc LIMIT $max;",
        max,
        r => new PendingScreenshot(
            Guid.Parse(r.GetString(r.GetOrdinal("client_event_id"))),
            r.GetNullableString("user_sid"),
            SqlTime.Parse(r.GetString(r.GetOrdinal("captured_at"))),
            r.GetString(r.GetOrdinal("file_path")),
            r.GetNullableInt32("width"),
            r.GetNullableInt32("height")));

    public sealed record PendingConsent(string UserSid, int PolicyVersion, DateTimeOffset AcknowledgedAt);

    public List<PendingConsent> DequeueConsents(int max) => Query(
        "SELECT * FROM consent_records WHERE sent_utc IS NULL ORDER BY acknowledged_at LIMIT $max;",
        max,
        r => new PendingConsent(
            r.GetString(r.GetOrdinal("user_sid")),
            r.GetInt32(r.GetOrdinal("policy_version")),
            SqlTime.Parse(r.GetString(r.GetOrdinal("acknowledged_at")))));

    // -------------------------------------------------------------------------
    // Acknowledgement and retry bookkeeping
    // -------------------------------------------------------------------------

    private static string KeyColumn(TelemetryChannel channel) => channel switch
    {
        TelemetryChannel.Attendance => "client_event_id",
        TelemetryChannel.ActivityMetric => "client_event_id",
        TelemetryChannel.ActivitySession => "client_event_id",
        TelemetryChannel.BrowserActivity => "client_event_id",
        TelemetryChannel.UsbEvent => "client_event_id",
        TelemetryChannel.Alert => "client_event_id",
        _ => throw new ArgumentOutOfRangeException(nameof(channel), channel, null)
    };

    private static string TableName(TelemetryChannel channel) => channel switch
    {
        TelemetryChannel.Attendance => "attendance_sessions",
        TelemetryChannel.ActivityMetric => "activity_metrics",
        TelemetryChannel.ActivitySession => "activity_sessions",
        TelemetryChannel.BrowserActivity => "browser_activity",
        TelemetryChannel.UsbEvent => "usb_events",
        TelemetryChannel.Alert => "alerts",
        _ => throw new ArgumentOutOfRangeException(nameof(channel), channel, null)
    };

    /// <summary>Marks server-acknowledged rows as sent. Swept from disk later by <see cref="Purge"/>.</summary>
    public void MarkSent(TelemetryChannel channel, IReadOnlyCollection<Guid> clientEventIds)
    {
        if (clientEventIds.Count == 0) return;

        using var connection = _store.Open();
        using var transaction = connection.BeginTransaction();

        foreach (var id in clientEventIds)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            // Table and column names come from the closed enum switches above, never from
            // caller input, so string interpolation here cannot carry injected SQL.
            command.CommandText =
                $"UPDATE {TableName(channel)} SET sent_utc = $now WHERE {KeyColumn(channel)} = $id;";
            command.Parameters.AddWithValue("$now", SqlTime.Now());
            command.Parameters.AddWithValue("$id", id.ToString());
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    /// <summary>
    /// Marks an attendance snapshot sent only when the row is still the exact revision that was
    /// uploaded. A host write can close a session while its earlier open snapshot is in flight;
    /// accepting that older acknowledgement must not mark the unsent logout revision delivered.
    /// </summary>
    public void MarkAttendanceSent(IReadOnlyCollection<AttendanceEvent> sentEvents,
        IReadOnlyCollection<Guid> acknowledgedClientEventIds)
    {
        if (sentEvents.Count == 0 || acknowledgedClientEventIds.Count == 0) return;

        var acknowledged = acknowledgedClientEventIds.ToHashSet();

        using var connection = _store.Open();
        using var transaction = connection.BeginTransaction();

        foreach (var sentEvent in sentEvents)
        {
            if (!acknowledged.Contains(sentEvent.ClientEventId)) continue;

            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                UPDATE attendance_sessions
                SET sent_utc = $now
                WHERE client_event_id = $clientEventId
                  AND revision = $revision;
                """;
            command.Parameters.AddWithValue("$now", SqlTime.Now());
            command.Parameters.AddWithValue("$clientEventId", sentEvent.ClientEventId.ToString());
            command.Parameters.AddWithValue("$revision", sentEvent.Revision);
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public void MarkScreenshotSent(Guid clientEventId)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE screenshots SET sent_utc = $now WHERE client_event_id = $id;";
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.Parameters.AddWithValue("$id", clientEventId.ToString());
        command.ExecuteNonQuery();
    }

    public void MarkConsentSent(string userSid, int policyVersion)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE consent_records SET sent_utc = $now
            WHERE user_sid = $sid AND policy_version = $version;
            """;
        command.Parameters.AddWithValue("$now", SqlTime.Now());
        command.Parameters.AddWithValue("$sid", userSid);
        command.Parameters.AddWithValue("$version", policyVersion);
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// Advances the attempt counter for events the server actively refused.
    ///
    /// Only *rejections* count here, never transient network or 5xx failures. A row's
    /// <c>attempts</c> is what eventually causes <see cref="DropExhausted"/> to discard it, so
    /// counting an unreachable server would age out perfectly good data during an outage - the
    /// precise opposite of what the offline queue exists for.
    ///
    /// Scoped to the ids actually in the failed request rather than every pending row, so one
    /// malformed event cannot push the whole channel toward being dropped.
    /// </summary>
    public void RecordRejection(TelemetryChannel channel, IReadOnlyCollection<Guid> clientEventIds)
    {
        if (clientEventIds.Count == 0) return;

        using var connection = _store.Open();
        using var transaction = connection.BeginTransaction();

        foreach (var id in clientEventIds)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            // Identifiers come from the closed enum switches, never caller input.
            command.CommandText =
                $"UPDATE {TableName(channel)} SET attempts = attempts + 1 WHERE {KeyColumn(channel)} = $id;";
            command.Parameters.AddWithValue("$id", id.ToString());
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    /// <summary>
    /// Discards pending rows the server has refused <paramref name="maxAttempts"/> times.
    ///
    /// Without this, an event the server will never accept - a schema mismatch, a value outside
    /// its enums - is resent on every sync cycle until the retention window expires weeks later.
    /// At a two-minute batch interval that is thousands of pointless requests per poisoned row,
    /// and it delays every healthy event queued behind it.
    ///
    /// Returns the number dropped per channel so the caller can log what was lost. Losing data is
    /// the point here, so it must never happen quietly.
    /// </summary>
    public IReadOnlyDictionary<TelemetryChannel, int> DropExhausted(int maxAttempts)
    {
        var dropped = new Dictionary<TelemetryChannel, int>();

        using var connection = _store.Open();
        using var transaction = connection.BeginTransaction();

        foreach (var channel in Enum.GetValues<TelemetryChannel>())
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                $"DELETE FROM {TableName(channel)} WHERE sent_utc IS NULL AND attempts >= $max;";
            command.Parameters.AddWithValue("$max", maxAttempts);

            var count = command.ExecuteNonQuery();
            if (count > 0) dropped[channel] = count;
        }

        transaction.Commit();
        return dropped;
    }

    public int PendingCount(TelemetryChannel channel)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(1) FROM {TableName(channel)} WHERE sent_utc IS NULL;";
        return Convert.ToInt32(command.ExecuteScalar());
    }

    /// <summary>
    /// Sweeps acknowledged rows, and drops undelivered ones older than the policy's
    /// UndeliveredRetentionDays so a workstation that never reaches the server does not fill
    /// its own disk (spec section 3.1, Features.md "Configuring Policies").
    ///
    /// Returns the screenshot files that were dropped so the caller can delete them from disk.
    /// </summary>
    public IReadOnlyList<string> Purge(int undeliveredRetentionDays)
    {
        var cutoff = SqlTime.From(DateTimeOffset.UtcNow.AddDays(-undeliveredRetentionDays));
        var orphanedFiles = new List<string>();

        using var connection = _store.Open();
        using var transaction = connection.BeginTransaction();

        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "SELECT file_path FROM screenshots WHERE sent_utc IS NOT NULL OR created_utc < $cutoff;";
            command.Parameters.AddWithValue("$cutoff", cutoff);
            using var reader = command.ExecuteReader();
            while (reader.Read()) orphanedFiles.Add(reader.GetString(0));
        }

        foreach (var table in new[]
                 {
                     "activity_metrics", "activity_sessions",
                     "browser_activity", "usb_events", "alerts", "screenshots"
                 })
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                $"DELETE FROM {table} WHERE sent_utc IS NOT NULL OR created_utc < $cutoff;";
            command.Parameters.AddWithValue("$cutoff", cutoff);
            command.ExecuteNonQuery();
        }

        // Attendance is swept on the same terms with one addition: an OPEN session is never
        // deleted just because it has been acknowledged. Every other table holds finished
        // observations, so delivery is the end of the row's life. An attendance row is the live
        // state of a session that is still running - it is acknowledged and then rewritten, over
        // and over, until the session ends. Deleting it at the first acknowledgement would restart
        // the session from scratch on the next refresh: a fresh row with revision 1, which the
        // server reads as older than everything it already holds for that session and discards.
        // It would also lose the row the startup recovery pass reads to close sessions an unclean
        // shutdown left open.
        //
        // The age clause still applies. A row open past the undelivered-retention horizon is days
        // stale and the server's own reaper has long since closed its counterpart; keeping it on
        // disk forever to preserve a counter nothing will consult again is the worse trade.
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                DELETE FROM attendance_sessions
                WHERE (sent_utc IS NOT NULL AND logout_time IS NOT NULL)
                   OR created_utc < $cutoff;
                """;
            command.Parameters.AddWithValue("$cutoff", cutoff);
            command.ExecuteNonQuery();
        }

        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "DELETE FROM consent_records WHERE sent_utc IS NOT NULL;";
            command.ExecuteNonQuery();
        }

        transaction.Commit();
        return orphanedFiles;
    }

    /// <summary>
    /// Closes attendance sessions the agent never got to finish - a power loss, a killed host, an
    /// upgrade that replaced the executable - so the day's attendance is not left open forever
    /// (Features.md "Attendace report" edge cases).
    ///
    /// TWO THINGS THIS MUST GET RIGHT, both of which it previously got wrong.
    ///
    /// The logout time is the last instant the agent actually observed, reconstructed from the
    /// running totals on the row itself: they are refreshed on every flush, so login plus the
    /// observed seconds is precisely how far the session had got when it was last persisted. It
    /// used to be stamped at <c>login_time</c>, which reported a session with a quarter of an hour
    /// of recorded work on it as having ended the moment it began - a zero-length working day, on
    /// exactly the rows where the truth was already sitting in the adjacent columns.
    ///
    /// And it only applies to sessions that are actually over. Every open row has a null logout
    /// time, including the row of the session running right now: the host sends null on every
    /// periodic flush and only fills it in at the end. Closing all of them at startup stamped a
    /// logout on the live session while the employee was still at their desk. A row is treated as
    /// abandoned only once it has gone <see cref="AgentCadence.AttendanceStale"/> without being
    /// refreshed, which a live host cannot do.
    /// </summary>
    public int RecoverOpenAttendanceSessions()
    {
        var now = DateTimeOffset.UtcNow;
        var abandoned = new List<(string SessionId, DateTimeOffset LastObservedAt)>();

        using var connection = _store.Open();

        using (var select = connection.CreateCommand())
        {
            select.CommandText = """
                SELECT session_id, login_time, total_active_seconds + total_idle_seconds
                FROM attendance_sessions
                WHERE logout_time IS NULL;
                """;

            using var reader = select.ExecuteReader();
            while (reader.Read())
            {
                var loginTime = SqlTime.Parse(reader.GetString(1));
                var observedSeconds = reader.GetInt32(2);

                // Where the session had got to when it last wrote. Bounded by now, because a clock
                // moved backwards since the row was written would otherwise put the logout in the
                // future.
                var lastObservedAt = loginTime.AddSeconds(observedSeconds);
                if (lastObservedAt > now) lastObservedAt = now;

                if (now - lastObservedAt < AgentCadence.AttendanceStale) continue;

                abandoned.Add((reader.GetString(0), lastObservedAt));
            }
        }

        var recovered = 0;

        foreach (var (sessionId, lastObservedAt) in abandoned)
        {
            using var update = connection.CreateCommand();
            update.CommandText = """
                UPDATE attendance_sessions
                SET logout_time = $logoutTime,
                    end_reason  = 'Recovered',
                    revision    = revision + 1,
                    sent_utc    = NULL,
                    attempts    = 0
                WHERE session_id = $sessionId AND logout_time IS NULL;
                """;
            update.Parameters.AddWithValue("$logoutTime", SqlTime.From(lastObservedAt));
            update.Parameters.AddWithValue("$sessionId", sessionId);
            recovered += update.ExecuteNonQuery();
        }

        if (recovered > 0)
        {
            // Logged as a warning because the logout time is inferred, not observed: it is
            // accurate to the flush interval, and the reason column says so.
            _logger.LogWarning(
                "Recovered {Count} attendance session(s) left open by an unclean shutdown; " +
                "logout time inferred from the last persisted totals",
                recovered);
        }

        return recovered;
    }

    // -------------------------------------------------------------------------

    private List<T> Query<T>(string sql, int max, Func<SqliteDataReader, T> map)
    {
        using var connection = _store.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("$max", max);

        var results = new List<T>();
        using var reader = command.ExecuteReader();
        while (reader.Read()) results.Add(map(reader));
        return results;
    }

    private static TEnum? ParseNullableEnum<TEnum>(string? value) where TEnum : struct, Enum =>
        string.IsNullOrEmpty(value) ? null : Enum.Parse<TEnum>(value);

    private static Guid? ParseNullableGuid(string? value) =>
        string.IsNullOrEmpty(value) ? null : Guid.Parse(value);
}

internal static class SqliteReaderExtensions
{
    public static string? GetNullableString(this SqliteDataReader reader, string column)
    {
        var ordinal = reader.GetOrdinal(column);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    public static int? GetNullableInt32(this SqliteDataReader reader, string column)
    {
        var ordinal = reader.GetOrdinal(column);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }
}
