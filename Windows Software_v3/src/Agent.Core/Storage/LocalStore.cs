using Agent.Core.Contracts;
using Agent.Core.Policy;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Agent.Core.Storage;

/// <summary>
/// The agent's local database: typed telemetry tables, the offline queue, and the cached policy.
///
/// Concurrency: opens a short-lived connection per operation and lets Microsoft.Data.Sqlite
/// pool them. The schema runs in WAL mode, so the sync worker can read pending rows while
/// collectors write new ones without either blocking the other.
/// </summary>
public sealed class LocalStore
{
    private readonly string _connectionString;
    private readonly ILogger<LocalStore> _logger;

    public LocalStore(ILogger<LocalStore> logger, string? databasePath = null)
    {
        _logger = logger;
        AgentPaths.EnsureCreated();

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath ?? AgentPaths.DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            Pooling = true
        }.ToString();
    }

    internal SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    public void Initialize()
    {
        using var connection = Open();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = LocalStoreSchema.Sql;
            command.ExecuteNonQuery();
        }

        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                INSERT INTO schema_info (version, applied_utc)
                SELECT $version, $now
                WHERE NOT EXISTS (SELECT 1 FROM schema_info WHERE version = $version);
                """;
            command.Parameters.AddWithValue("$version", LocalStoreSchema.Version);
            command.Parameters.AddWithValue("$now", SqlTime.Now());
            command.ExecuteNonQuery();
        }

        _logger.LogInformation("Local store ready at {Path} (schema v{Version})",
            AgentPaths.DatabasePath, LocalStoreSchema.Version);
    }

    // -------------------------------------------------------------------------
    // Policy cache
    // -------------------------------------------------------------------------

    /// <summary>
    /// Replaces the cached policy. Written in one transaction with its category and
    /// working-day rows so a crash mid-write can never leave the agent running half of one
    /// policy version and half of another.
    /// </summary>
    public void SavePolicy(AgentPolicy policy)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();

        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO policy_cache (
                    id, version, attendance_enabled, activity_enabled, idle_threshold_seconds,
                    app_session_enabled, app_session_poll_seconds,
                    browser_monitor_enabled, browser_uia_timeout_ms, browser_max_retry_attempts,
                    screenshot_enabled, screenshot_interval_seconds, screenshot_jpeg_quality,
                    usb_enabled, usb_reconciliation_interval_seconds, usb_alert_on_insertion,
                    alert_enabled, alert_idle_enabled, alert_idle_normal_seconds,
                    alert_idle_moderate_seconds, alert_idle_severe_seconds,
                    alert_idle_renotify_seconds, alert_blacklist_enabled,
                    alert_outside_working_hours,
                    sync_batch_interval_seconds, sync_max_batch_size,
                    sync_min_retry_backoff_seconds, sync_max_retry_backoff_seconds,
                    retention_days, undelivered_retention_days,
                    working_hours_start_local, working_hours_end_local, updated_utc
                ) VALUES (
                    1, $version, $attendanceEnabled, $activityEnabled, $idleThreshold,
                    $appSessionEnabled, $appSessionPoll,
                    $browserEnabled, $browserTimeout, $browserRetries,
                    $screenshotEnabled, $screenshotInterval, $screenshotQuality,
                    $usbEnabled, $usbInterval, $usbAlert,
                    $alertEnabled, $alertIdleEnabled, $alertIdleNormal,
                    $alertIdleModerate, $alertIdleSevere,
                    $alertIdleRenotify, $alertBlacklist,
                    $alertOutsideHours,
                    $syncInterval, $syncBatchSize,
                    $syncMinBackoff, $syncMaxBackoff,
                    $retentionDays, $undeliveredDays,
                    $workStart, $workEnd, $now
                )
                ON CONFLICT(id) DO UPDATE SET
                    version = excluded.version,
                    attendance_enabled = excluded.attendance_enabled,
                    activity_enabled = excluded.activity_enabled,
                    idle_threshold_seconds = excluded.idle_threshold_seconds,
                    app_session_enabled = excluded.app_session_enabled,
                    app_session_poll_seconds = excluded.app_session_poll_seconds,
                    browser_monitor_enabled = excluded.browser_monitor_enabled,
                    browser_uia_timeout_ms = excluded.browser_uia_timeout_ms,
                    browser_max_retry_attempts = excluded.browser_max_retry_attempts,
                    screenshot_enabled = excluded.screenshot_enabled,
                    screenshot_interval_seconds = excluded.screenshot_interval_seconds,
                    screenshot_jpeg_quality = excluded.screenshot_jpeg_quality,
                    usb_enabled = excluded.usb_enabled,
                    usb_reconciliation_interval_seconds = excluded.usb_reconciliation_interval_seconds,
                    usb_alert_on_insertion = excluded.usb_alert_on_insertion,
                    alert_enabled = excluded.alert_enabled,
                    alert_idle_enabled = excluded.alert_idle_enabled,
                    alert_idle_normal_seconds = excluded.alert_idle_normal_seconds,
                    alert_idle_moderate_seconds = excluded.alert_idle_moderate_seconds,
                    alert_idle_severe_seconds = excluded.alert_idle_severe_seconds,
                    alert_idle_renotify_seconds = excluded.alert_idle_renotify_seconds,
                    alert_blacklist_enabled = excluded.alert_blacklist_enabled,
                    alert_outside_working_hours = excluded.alert_outside_working_hours,
                    sync_batch_interval_seconds = excluded.sync_batch_interval_seconds,
                    sync_max_batch_size = excluded.sync_max_batch_size,
                    sync_min_retry_backoff_seconds = excluded.sync_min_retry_backoff_seconds,
                    sync_max_retry_backoff_seconds = excluded.sync_max_retry_backoff_seconds,
                    retention_days = excluded.retention_days,
                    undelivered_retention_days = excluded.undelivered_retention_days,
                    working_hours_start_local = excluded.working_hours_start_local,
                    working_hours_end_local = excluded.working_hours_end_local,
                    updated_utc = excluded.updated_utc;
                """;

            command.Parameters.AddWithValue("$version", policy.Version);
            command.Parameters.AddWithValue("$attendanceEnabled", policy.Attendance.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$activityEnabled", policy.Activity.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$idleThreshold", policy.Activity.IdleThresholdSeconds);
            command.Parameters.AddWithValue("$appSessionEnabled", policy.AppSession.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$appSessionPoll", policy.AppSession.PollSeconds);
            command.Parameters.AddWithValue("$browserEnabled", policy.BrowserMonitor.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$browserTimeout", policy.BrowserMonitor.UiaTimeoutMs);
            command.Parameters.AddWithValue("$browserRetries", policy.BrowserMonitor.MaxRetryAttempts);
            command.Parameters.AddWithValue("$screenshotEnabled", policy.Screenshot.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$screenshotInterval", policy.Screenshot.IntervalSeconds);
            command.Parameters.AddWithValue("$screenshotQuality", policy.Screenshot.JpegQuality);
            command.Parameters.AddWithValue("$usbEnabled", policy.Usb.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$usbInterval", policy.Usb.ReconciliationIntervalSeconds);
            command.Parameters.AddWithValue("$usbAlert", policy.Usb.AlertOnInsertion ? 1 : 0);
            command.Parameters.AddWithValue("$alertEnabled", policy.Alert.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$alertIdleEnabled", policy.Alert.Idle.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$alertIdleNormal", policy.Alert.Idle.NormalSeconds);
            command.Parameters.AddWithValue("$alertIdleModerate", policy.Alert.Idle.ModerateSeconds);
            command.Parameters.AddWithValue("$alertIdleSevere", policy.Alert.Idle.SevereSeconds);
            command.Parameters.AddWithValue("$alertIdleRenotify", policy.Alert.Idle.RenotifySeconds);
            command.Parameters.AddWithValue("$alertBlacklist", policy.Alert.BlacklistEnabled ? 1 : 0);
            command.Parameters.AddWithValue("$alertOutsideHours", policy.Alert.NotifyOutsideWorkingHours ? 1 : 0);
            command.Parameters.AddWithValue("$syncInterval", policy.Sync.BatchIntervalSeconds);
            command.Parameters.AddWithValue("$syncBatchSize", policy.Sync.MaxBatchSize);
            command.Parameters.AddWithValue("$syncMinBackoff", policy.Sync.MinRetryBackoffSeconds);
            command.Parameters.AddWithValue("$syncMaxBackoff", policy.Sync.MaxRetryBackoffSeconds);
            command.Parameters.AddWithValue("$retentionDays", policy.Retention.RetentionDays);
            command.Parameters.AddWithValue("$undeliveredDays", policy.Retention.UndeliveredRetentionDays);
            command.Parameters.AddWithValue("$workStart", policy.WorkingHours.StartLocal);
            command.Parameters.AddWithValue("$workEnd", policy.WorkingHours.EndLocal);
            command.Parameters.AddWithValue("$now", SqlTime.Now());
            command.ExecuteNonQuery();
        }

        ReplaceWorkingDays(connection, transaction, policy.WorkingHours.WorkingDays);
        ReplaceCategories(connection, transaction, policy.Categories);

        transaction.Commit();
    }

    private static void ReplaceWorkingDays(SqliteConnection connection, SqliteTransaction transaction, List<string> days)
    {
        using (var delete = connection.CreateCommand())
        {
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM policy_working_days;";
            delete.ExecuteNonQuery();
        }

        foreach (var day in days)
        {
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = "INSERT OR IGNORE INTO policy_working_days (day_name) VALUES ($day);";
            insert.Parameters.AddWithValue("$day", day);
            insert.ExecuteNonQuery();
        }
    }

    private static void ReplaceCategories(SqliteConnection connection, SqliteTransaction transaction, List<CategoryRule> rules)
    {
        using (var delete = connection.CreateCommand())
        {
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM policy_categories;";
            delete.ExecuteNonQuery();
        }

        foreach (var rule in rules)
        {
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT OR REPLACE INTO policy_categories (pattern, target, tag, is_blacklisted)
                VALUES ($pattern, $target, $tag, $blacklisted);
                """;
            insert.Parameters.AddWithValue("$pattern", rule.Pattern);
            insert.Parameters.AddWithValue("$target", rule.Target.ToString());
            insert.Parameters.AddWithValue("$tag", rule.Tag.ToString());
            insert.Parameters.AddWithValue("$blacklisted", rule.IsBlacklisted ? 1 : 0);
            insert.ExecuteNonQuery();
        }
    }

    /// <summary>
    /// The cached policy, or <c>null</c> if the agent has never successfully fetched one.
    /// Callers fall back to <c>new AgentPolicy()</c>, whose defaults match Features.md - the
    /// agent must collect from first boot rather than wait for the network.
    /// </summary>
    public AgentPolicy? LoadPolicy()
    {
        using var connection = Open();

        using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM policy_cache WHERE id = 1;";
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return null;

        var policy = new AgentPolicy
        {
            Version = reader.GetInt32(reader.GetOrdinal("version")),
            Attendance = new AttendancePolicy { Enabled = reader.GetBoolean(reader.GetOrdinal("attendance_enabled")) },
            Activity = new ActivityPolicy
            {
                Enabled = reader.GetBoolean(reader.GetOrdinal("activity_enabled")),
                IdleThresholdSeconds = reader.GetInt32(reader.GetOrdinal("idle_threshold_seconds"))
            },
            AppSession = new AppSessionPolicy
            {
                Enabled = reader.GetBoolean(reader.GetOrdinal("app_session_enabled")),
                PollSeconds = reader.GetInt32(reader.GetOrdinal("app_session_poll_seconds"))
            },
            BrowserMonitor = new BrowserMonitorPolicy
            {
                Enabled = reader.GetBoolean(reader.GetOrdinal("browser_monitor_enabled")),
                UiaTimeoutMs = reader.GetInt32(reader.GetOrdinal("browser_uia_timeout_ms")),
                MaxRetryAttempts = reader.GetInt32(reader.GetOrdinal("browser_max_retry_attempts"))
            },
            Screenshot = new ScreenshotPolicy
            {
                Enabled = reader.GetBoolean(reader.GetOrdinal("screenshot_enabled")),
                IntervalSeconds = reader.GetInt32(reader.GetOrdinal("screenshot_interval_seconds")),
                JpegQuality = reader.GetInt32(reader.GetOrdinal("screenshot_jpeg_quality"))
            },
            Usb = new UsbPolicy
            {
                Enabled = reader.GetBoolean(reader.GetOrdinal("usb_enabled")),
                ReconciliationIntervalSeconds = reader.GetInt32(reader.GetOrdinal("usb_reconciliation_interval_seconds")),
                AlertOnInsertion = reader.GetBoolean(reader.GetOrdinal("usb_alert_on_insertion"))
            },
            Alert = new AlertPolicy
            {
                Enabled = reader.GetBoolean(reader.GetOrdinal("alert_enabled")),
                Idle = new IdleAlertPolicy
                {
                    Enabled = reader.GetBoolean(reader.GetOrdinal("alert_idle_enabled")),
                    NormalSeconds = reader.GetInt32(reader.GetOrdinal("alert_idle_normal_seconds")),
                    ModerateSeconds = reader.GetInt32(reader.GetOrdinal("alert_idle_moderate_seconds")),
                    SevereSeconds = reader.GetInt32(reader.GetOrdinal("alert_idle_severe_seconds")),
                    RenotifySeconds = reader.GetInt32(reader.GetOrdinal("alert_idle_renotify_seconds"))
                },
                BlacklistEnabled = reader.GetBoolean(reader.GetOrdinal("alert_blacklist_enabled")),
                NotifyOutsideWorkingHours = reader.GetBoolean(reader.GetOrdinal("alert_outside_working_hours"))
            },
            Sync = new SyncPolicy
            {
                BatchIntervalSeconds = reader.GetInt32(reader.GetOrdinal("sync_batch_interval_seconds")),
                MaxBatchSize = reader.GetInt32(reader.GetOrdinal("sync_max_batch_size")),
                MinRetryBackoffSeconds = reader.GetInt32(reader.GetOrdinal("sync_min_retry_backoff_seconds")),
                MaxRetryBackoffSeconds = reader.GetInt32(reader.GetOrdinal("sync_max_retry_backoff_seconds"))
            },
            Retention = new RetentionPolicy
            {
                RetentionDays = reader.GetInt32(reader.GetOrdinal("retention_days")),
                UndeliveredRetentionDays = reader.GetInt32(reader.GetOrdinal("undelivered_retention_days"))
            },
            WorkingHours = new WorkingHoursPolicy
            {
                StartLocal = reader.GetString(reader.GetOrdinal("working_hours_start_local")),
                EndLocal = reader.GetString(reader.GetOrdinal("working_hours_end_local")),
                WorkingDays = []
            },
            Categories = []
        };

        reader.Close();

        using (var daysCommand = connection.CreateCommand())
        {
            daysCommand.CommandText = "SELECT day_name FROM policy_working_days;";
            using var daysReader = daysCommand.ExecuteReader();
            while (daysReader.Read()) policy.WorkingHours.WorkingDays.Add(daysReader.GetString(0));
        }

        using (var categoriesCommand = connection.CreateCommand())
        {
            categoriesCommand.CommandText = "SELECT pattern, target, tag, is_blacklisted FROM policy_categories;";
            using var categoriesReader = categoriesCommand.ExecuteReader();
            while (categoriesReader.Read())
            {
                policy.Categories.Add(new CategoryRule
                {
                    Pattern = categoriesReader.GetString(0),
                    Target = Enum.Parse<CategoryTarget>(categoriesReader.GetString(1)),
                    Tag = Enum.Parse<ProductivityTag>(categoriesReader.GetString(2)),
                    IsBlacklisted = categoriesReader.GetBoolean(3)
                });
            }
        }

        return policy;
    }

    // -------------------------------------------------------------------------
    // Consent (spec section 3)
    // -------------------------------------------------------------------------

    public void RecordConsent(string userSid, int policyVersion, DateTimeOffset acknowledgedAt)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO consent_records (user_sid, policy_version, acknowledged_at)
            VALUES ($sid, $version, $at);
            """;
        command.Parameters.AddWithValue("$sid", userSid);
        command.Parameters.AddWithValue("$version", policyVersion);
        command.Parameters.AddWithValue("$at", SqlTime.From(acknowledgedAt));
        command.ExecuteNonQuery();
    }

    public bool HasConsented(string userSid, int policyVersion)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT COUNT(1) FROM consent_records WHERE user_sid = $sid AND policy_version = $version;
            """;
        command.Parameters.AddWithValue("$sid", userSid);
        command.Parameters.AddWithValue("$version", policyVersion);
        return Convert.ToInt64(command.ExecuteScalar()) > 0;
    }
}

/// <summary>
/// Timestamp conversion for the store. Everything is ISO-8601 UTC round-trip text ('o'),
/// which sorts lexicographically in the same order it sorts chronologically and is immune to
/// the workstation's timezone being changed between write and read.
/// </summary>
internal static class SqlTime
{
    public static string Now() => DateTimeOffset.UtcNow.ToString("o");

    public static string From(DateTimeOffset value) => value.ToUniversalTime().ToString("o");

    public static string? FromNullable(DateTimeOffset? value) => value.HasValue ? From(value.Value) : null;

    public static DateTimeOffset Parse(string value) =>
        DateTimeOffset.Parse(value, null, System.Globalization.DateTimeStyles.RoundtripKind);

    public static DateTimeOffset? ParseNullable(string? value) =>
        string.IsNullOrEmpty(value) ? null : Parse(value);
}
