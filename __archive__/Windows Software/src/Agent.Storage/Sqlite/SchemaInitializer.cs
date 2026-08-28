using Microsoft.Data.Sqlite;

namespace Agent.Storage.Sqlite;

public sealed class SchemaInitializer(ISqliteConnectionFactory connectionFactory)
{
    public void EnsureCreated()
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            CREATE TABLE IF NOT EXISTS outbox (
                client_event_id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                priority INTEGER NOT NULL,
                created_at_utc TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS ix_outbox_channel ON outbox (channel);

            CREATE TABLE IF NOT EXISTS attendance_events (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                session_id INTEGER NOT NULL,
                is_remote_session INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at_utc TEXT NOT NULL,
                reason TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_attendance_events_time ON attendance_events (occurred_at_utc);

            CREATE TABLE IF NOT EXISTS app_sessions (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                windows_session_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                process_id INTEGER NOT NULL,
                executable TEXT NOT NULL,
                window_title TEXT NOT NULL,
                start_time_utc TEXT NOT NULL,
                end_time_utc TEXT NULL,
                productivity_tag TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_app_sessions_open ON app_sessions (end_time_utc);

            CREATE TABLE IF NOT EXISTS activity_sessions (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                state TEXT NOT NULL,
                reason TEXT NOT NULL,
                start_time_utc TEXT NOT NULL,
                end_time_utc TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_activity_sessions_open ON activity_sessions (end_time_utc);

            CREATE TABLE IF NOT EXISTS browser_navigations (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                browser TEXT NOT NULL,
                raw_url TEXT NOT NULL,
                normalized_url TEXT NULL,
                domain TEXT NULL,
                category TEXT NOT NULL,
                occurred_at_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_browser_navigations_time ON browser_navigations (occurred_at_utc);

            CREATE TABLE IF NOT EXISTS screenshots (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                captured_at_utc TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                monitor_count INTEGER NOT NULL,
                local_encrypted_file_path TEXT NOT NULL,
                encoded_size_bytes INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_screenshots_time ON screenshots (captured_at_utc);

            CREATE TABLE IF NOT EXISTS usb_events (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                pnp_device_id TEXT NOT NULL,
                serial_number TEXT NULL,
                model TEXT NULL,
                manufacturer TEXT NULL,
                capacity_bytes INTEGER NULL,
                volumes_json TEXT NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_usb_events_device_time ON usb_events (pnp_device_id, occurred_at_utc);

            CREATE TABLE IF NOT EXISTS alerts (
                client_event_id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                user_sid TEXT NOT NULL,
                type TEXT NOT NULL,
                severity TEXT NOT NULL,
                state TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                context_json TEXT NOT NULL,
                triggered_at_utc TEXT NOT NULL,
                acknowledged_at_utc TEXT NULL,
                resolved_at_utc TEXT NULL,
                last_notified_at_utc TEXT NULL,
                escalation_level INTEGER NOT NULL,
                notification_count INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_alerts_open ON alerts (machine_id, user_sid, type, resolved_at_utc);

            CREATE TABLE IF NOT EXISTS consent_records (
                user_sid TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL,
                policy_version INTEGER NOT NULL,
                acknowledged_at_utc TEXT NOT NULL
            );
            """;
        command.ExecuteNonQuery();
    }
}
