namespace Agent.Core.Storage;

/// <summary>
/// The local SQLite schema.
///
/// Same rule as the backend: no serialized documents. Every telemetry field gets its own
/// column, so the offline queue stays inspectable with a SQL client and a malformed value
/// fails at collection time rather than surfacing as a 400 from the server minutes later.
///
/// Each telemetry table carries its own <c>sent_utc</c>/<c>attempts</c> columns rather than a
/// shared sync_state side table. Sync is then a partial-indexed scan per table with no join,
/// and Features.md's "deleting local copies only after successful synchronization" is a plain
/// DELETE on acknowledged ids.
///
/// Timestamps are stored as ISO-8601 UTC strings ('o' round-trip format). SQLite has no date
/// type; text sorts correctly in that format and survives a timezone change on the workstation,
/// which a local-time or Unix-tick column would not.
/// </summary>
internal static class LocalStoreSchema
{
    public const int Version = 1;

    public const string Sql = """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS schema_info (
            version     INTEGER NOT NULL,
            applied_utc TEXT    NOT NULL
        );

        -- Features.md "Attendace report".
        -- Upserted on session_id: an open row is rewritten in place and re-queued for sync every
        -- time its running totals are refreshed. Once logout_time is set the row is closed and no
        -- longer accepts writes - presence resumed after a lock or a suspend is a new session, not
        -- an amendment to the one that ended.
        CREATE TABLE IF NOT EXISTS attendance_sessions (
            session_id           TEXT    PRIMARY KEY,
            client_event_id      TEXT    NOT NULL,
            user_sid             TEXT    NOT NULL,
            login_time           TEXT    NOT NULL,
            logout_time          TEXT    NULL,
            end_reason           TEXT    NULL,
            work_date            TEXT    NOT NULL,
            total_active_seconds INTEGER NOT NULL DEFAULT 0,
            total_idle_seconds   INTEGER NOT NULL DEFAULT 0,
            created_utc          TEXT    NOT NULL,
            sent_utc             TEXT    NULL,
            attempts             INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_attendance_pending
            ON attendance_sessions (sent_utc) WHERE sent_utc IS NULL;

        -- Features.md "Activity Level Metric".
        -- PRIVACY: counts only. There is deliberately no column here that could hold a key,
        -- a character or a sequence.
        CREATE TABLE IF NOT EXISTS activity_metrics (
            client_event_id         TEXT    PRIMARY KEY,
            session_id              TEXT    NOT NULL,
            key_count               INTEGER NOT NULL DEFAULT 0,
            mouse_count             INTEGER NOT NULL DEFAULT 0,
            mouse_left_key_count    INTEGER NOT NULL DEFAULT 0,
            mouse_right_key_count   INTEGER NOT NULL DEFAULT 0,
            mouse_middle_key_count  INTEGER NOT NULL DEFAULT 0,
            mouse_other_key_count   INTEGER NOT NULL DEFAULT 0,
            window_start_utc        TEXT    NOT NULL,
            window_end_utc          TEXT    NOT NULL,
            created_utc             TEXT    NOT NULL,
            sent_utc                TEXT    NULL,
            attempts                INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_activity_metrics_pending
            ON activity_metrics (sent_utc) WHERE sent_utc IS NULL;

        -- Features.md "Activity Logs".
        CREATE TABLE IF NOT EXISTS activity_sessions (
            activity_session_id TEXT    PRIMARY KEY,
            client_event_id     TEXT    NOT NULL,
            session_id          TEXT    NOT NULL,
            app_name            TEXT    NULL,
            process_name        TEXT    NULL,
            executable_path     TEXT    NULL,
            type                TEXT    NOT NULL,
            window_title        TEXT    NULL,
            start_time          TEXT    NOT NULL,
            end_time            TEXT    NOT NULL,
            duration_seconds    INTEGER NOT NULL,
            reason              TEXT    NULL,
            productivity_tag    TEXT    NOT NULL DEFAULT 'Neutral',
            created_utc         TEXT    NOT NULL,
            sent_utc            TEXT    NULL,
            attempts            INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_activity_sessions_pending
            ON activity_sessions (sent_utc) WHERE sent_utc IS NULL;

        -- Features.md "Browser Activity log".
        CREATE TABLE IF NOT EXISTS browser_activity (
            browser_activity_id TEXT    PRIMARY KEY,
            client_event_id     TEXT    NOT NULL,
            activity_session_id TEXT    NULL,
            browser             TEXT    NOT NULL,
            browser_version     TEXT    NULL,
            profile_name        TEXT    NULL,
            domain              TEXT    NOT NULL,
            raw_url             TEXT    NOT NULL,
            window_title        TEXT    NULL,
            page_title          TEXT    NULL,
            protocol            TEXT    NOT NULL DEFAULT 'Https',
            start_time          TEXT    NOT NULL,
            end_time            TEXT    NOT NULL,
            duration_seconds    INTEGER NOT NULL,
            productivity_tag    TEXT    NOT NULL DEFAULT 'Neutral',
            created_utc         TEXT    NOT NULL,
            sent_utc            TEXT    NULL,
            attempts            INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_browser_activity_pending
            ON browser_activity (sent_utc) WHERE sent_utc IS NULL;

        -- Features.md "USB Logs". Metadata only; contents are never inspected.
        CREATE TABLE IF NOT EXISTS usb_events (
            client_event_id TEXT    PRIMARY KEY,
            session_id      TEXT    NULL,
            event_type      TEXT    NOT NULL,
            device_type     TEXT    NOT NULL,
            friendly_name   TEXT    NULL,
            manufacturer    TEXT    NULL,
            model           TEXT    NULL,
            serial_number   TEXT    NULL,
            vendor_id       TEXT    NULL,
            product_id      TEXT    NULL,
            drive_letter    TEXT    NULL,
            volume_label    TEXT    NULL,
            capacity_bytes  TEXT    NULL,
            file_system     TEXT    NULL,
            event_time      TEXT    NOT NULL,
            created_utc     TEXT    NOT NULL,
            sent_utc        TEXT    NULL,
            attempts        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_usb_events_pending
            ON usb_events (sent_utc) WHERE sent_utc IS NULL;

        -- Features.md "Alert Notification". Context is typed columns, not a JSON string.
        CREATE TABLE IF NOT EXISTS alerts (
            client_event_id            TEXT    PRIMARY KEY,
            user_sid                   TEXT    NOT NULL,
            type                       TEXT    NOT NULL,
            severity                   TEXT    NOT NULL,
            state                      TEXT    NOT NULL DEFAULT 'New',
            title                      TEXT    NOT NULL,
            message                    TEXT    NOT NULL,
            idle_seconds               INTEGER NULL,
            threshold_seconds          INTEGER NULL,
            context_app_name           TEXT    NULL,
            context_process_name       TEXT    NULL,
            context_domain             TEXT    NULL,
            context_url                TEXT    NULL,
            context_usb_serial_number  TEXT    NULL,
            context_usb_friendly_name  TEXT    NULL,
            triggered_at               TEXT    NOT NULL,
            acknowledged_at            TEXT    NULL,
            resolved_at                TEXT    NULL,
            last_notified_at           TEXT    NULL,
            escalation_level           INTEGER NOT NULL DEFAULT 0,
            notification_count         INTEGER NOT NULL DEFAULT 0,
            created_utc                TEXT    NOT NULL,
            sent_utc                   TEXT    NULL,
            attempts                   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_alerts_pending
            ON alerts (sent_utc) WHERE sent_utc IS NULL;
        CREATE INDEX IF NOT EXISTS ix_alerts_open
            ON alerts (user_sid, type, resolved_at);

        -- Screenshot spool. The image itself is a file on disk (file_path); only its metadata
        -- lives here, so the database stays small and a failed upload can be retried from the
        -- original bytes.
        CREATE TABLE IF NOT EXISTS screenshots (
            client_event_id TEXT    PRIMARY KEY,
            user_sid        TEXT    NULL,
            captured_at     TEXT    NOT NULL,
            file_path       TEXT    NOT NULL,
            size_bytes      INTEGER NOT NULL,
            width           INTEGER NULL,
            height          INTEGER NULL,
            created_utc     TEXT    NOT NULL,
            sent_utc        TEXT    NULL,
            attempts        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_screenshots_pending
            ON screenshots (sent_utc) WHERE sent_utc IS NULL;

        -- Cached policy, one row. Stored as typed columns for the same reason as the backend:
        -- the service reads individual settings constantly and a blob would mean re-parsing.
        CREATE TABLE IF NOT EXISTS policy_cache (
            id                                  INTEGER PRIMARY KEY CHECK (id = 1),
            version                             INTEGER NOT NULL,
            attendance_enabled                  INTEGER NOT NULL,
            activity_enabled                    INTEGER NOT NULL,
            idle_threshold_seconds              INTEGER NOT NULL,
            app_session_enabled                 INTEGER NOT NULL,
            app_session_poll_seconds            INTEGER NOT NULL,
            browser_monitor_enabled             INTEGER NOT NULL,
            browser_uia_timeout_ms              INTEGER NOT NULL,
            browser_max_retry_attempts          INTEGER NOT NULL,
            screenshot_enabled                  INTEGER NOT NULL,
            screenshot_interval_seconds         INTEGER NOT NULL,
            screenshot_jpeg_quality             INTEGER NOT NULL,
            usb_enabled                         INTEGER NOT NULL,
            usb_reconciliation_interval_seconds INTEGER NOT NULL,
            usb_alert_on_insertion              INTEGER NOT NULL,
            alert_enabled                       INTEGER NOT NULL,
            alert_idle_enabled                  INTEGER NOT NULL,
            alert_idle_normal_seconds           INTEGER NOT NULL,
            alert_idle_moderate_seconds         INTEGER NOT NULL,
            alert_idle_severe_seconds           INTEGER NOT NULL,
            alert_idle_renotify_seconds         INTEGER NOT NULL,
            alert_blacklist_enabled             INTEGER NOT NULL,
            alert_outside_working_hours         INTEGER NOT NULL,
            sync_batch_interval_seconds         INTEGER NOT NULL,
            sync_max_batch_size                 INTEGER NOT NULL,
            sync_min_retry_backoff_seconds      INTEGER NOT NULL,
            sync_max_retry_backoff_seconds      INTEGER NOT NULL,
            retention_days                      INTEGER NOT NULL,
            undelivered_retention_days          INTEGER NOT NULL,
            working_hours_start_local           TEXT    NOT NULL,
            working_hours_end_local             TEXT    NOT NULL,
            updated_utc                         TEXT    NOT NULL
        );

        -- Scalar-list members of the policy, as rows rather than a delimited string.
        CREATE TABLE IF NOT EXISTS policy_working_days (
            day_name TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS policy_categories (
            pattern        TEXT    NOT NULL,
            target         TEXT    NOT NULL,
            tag            TEXT    NOT NULL,
            is_blacklisted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (target, pattern)
        );

        -- Consent acknowledgements (spec section 3), queued for upload like any other event.
        CREATE TABLE IF NOT EXISTS consent_records (
            user_sid        TEXT    NOT NULL,
            policy_version  INTEGER NOT NULL,
            acknowledged_at TEXT    NOT NULL,
            sent_utc        TEXT    NULL,
            attempts        INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_sid, policy_version)
        );
        """;
}
