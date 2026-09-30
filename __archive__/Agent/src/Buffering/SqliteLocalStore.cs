using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Agent.Core;

namespace Agent.Buffering
{
    public class SqliteLocalStore : ILocalStore
    {
        private readonly string _connectionString;
        private readonly string _dbPath;

        public SqliteLocalStore(string dbFileName = "agent_buffer.db")
        {
            _dbPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, dbFileName);
            _connectionString = $"Data Source={_dbPath};";
        }

        public async Task InitializeAsync()
        {
            // Create database folder if it doesn't exist
            var dir = Path.GetDirectoryName(_dbPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            // Enable WAL mode to prevent corruption during sudden power losses or Windows updates
            using (var command = new SqliteCommand("PRAGMA journal_mode=WAL;", connection))
            {
                await command.ExecuteNonQueryAsync();
            }

            // Create tables if they do not exist
            string createTablesQuery = @"
                CREATE TABLE IF NOT EXISTS activity_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    app_name TEXT,
                    window_title TEXT,
                    domain TEXT,
                    is_idle INTEGER NOT NULL,
                    activity_score INTEGER NOT NULL,
                    captured_at TEXT NOT NULL,
                    synced INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS screenshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    encrypted_data BLOB NOT NULL,
                    synced INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS usb_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    device_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    captured_at TEXT NOT NULL,
                    synced INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    first_login TEXT NOT NULL,
                    last_logout TEXT,
                    total_active_seconds INTEGER NOT NULL,
                    synced INTEGER DEFAULT 0
                );
            ";

            using (var command = new SqliteCommand(createTablesQuery, connection))
            {
                await command.ExecuteNonQueryAsync();
            }
        }

        public async Task EnqueueActivityAsync(ActivityLog log)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            string insertQuery = @"
                INSERT INTO activity_logs (device_id, app_name, window_title, domain, is_idle, activity_score, captured_at, synced)
                VALUES ($device_id, $app_name, $window_title, $domain, $is_idle, $activity_score, $captured_at, 0);
            ";

            using var command = new SqliteCommand(insertQuery, connection);
            command.Parameters.AddWithValue("$device_id", log.DeviceId);
            command.Parameters.AddWithValue("$app_name", (object?)log.AppName ?? DBNull.Value);
            command.Parameters.AddWithValue("$window_title", (object?)log.WindowTitle ?? DBNull.Value);
            command.Parameters.AddWithValue("$domain", (object?)log.Domain ?? DBNull.Value);
            command.Parameters.AddWithValue("$is_idle", log.IsIdle ? 1 : 0);
            command.Parameters.AddWithValue("$activity_score", log.ActivityScore);
            command.Parameters.AddWithValue("$captured_at", log.CapturedAt.ToString("o"));

            await command.ExecuteNonQueryAsync();
        }

        public async Task EnqueueScreenshotAsync(ScreenshotRecord screenshot)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            string insertQuery = @"
                INSERT INTO screenshots (device_id, captured_at, encrypted_data, synced)
                VALUES ($device_id, $captured_at, $encrypted_data, 0);
            ";

            using var command = new SqliteCommand(insertQuery, connection);
            command.Parameters.AddWithValue("$device_id", screenshot.DeviceId);
            command.Parameters.AddWithValue("$captured_at", screenshot.CapturedAt.ToString("o"));
            command.Parameters.AddWithValue("$encrypted_data", screenshot.EncryptedImageData);

            await command.ExecuteNonQueryAsync();
        }

        public async Task EnqueueUsbLogAsync(UsbDeviceRecord usbLog)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            string insertQuery = @"
                INSERT INTO usb_logs (device_id, device_name, action, captured_at, synced)
                VALUES ($device_id, $device_name, $action, $captured_at, 0);
            ";

            using var command = new SqliteCommand(insertQuery, connection);
            command.Parameters.AddWithValue("$device_id", usbLog.DeviceId);
            command.Parameters.AddWithValue("$device_name", usbLog.DeviceName);
            command.Parameters.AddWithValue("$action", usbLog.Action);
            command.Parameters.AddWithValue("$captured_at", usbLog.CapturedAt.ToString("o"));

            await command.ExecuteNonQueryAsync();
        }

        public async Task EnqueueAttendanceAsync(AttendanceRecord attendance)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            // First check if an attendance record for this date already exists
            string checkQuery = "SELECT id FROM attendance WHERE date = $date AND device_id = $device_id;";
            long? existingId = null;

            using (var checkCmd = new SqliteCommand(checkQuery, connection))
            {
                checkCmd.Parameters.AddWithValue("$date", attendance.Date.ToString("yyyy-MM-dd"));
                checkCmd.Parameters.AddWithValue("$device_id", attendance.DeviceId);
                using var reader = await checkCmd.ExecuteReaderAsync();
                if (await reader.ReadAsync())
                {
                    existingId = reader.GetInt64(0);
                }
            }

            if (existingId.HasValue)
            {
                // Update existing record
                string updateQuery = @"
                    UPDATE attendance 
                    SET last_logout = $last_logout, total_active_seconds = $total_active_seconds, synced = 0
                    WHERE id = $id;
                ";
                using var updateCmd = new SqliteCommand(updateQuery, connection);
                updateCmd.Parameters.AddWithValue("$last_logout", attendance.LastLogout.HasValue ? (object)attendance.LastLogout.Value.ToString("o") : DBNull.Value);
                updateCmd.Parameters.AddWithValue("$total_active_seconds", attendance.TotalActiveSeconds);
                updateCmd.Parameters.AddWithValue("$id", existingId.Value);
                await updateCmd.ExecuteNonQueryAsync();
            }
            else
            {
                // Insert new record
                string insertQuery = @"
                    INSERT INTO attendance (device_id, date, first_login, last_logout, total_active_seconds, synced)
                    VALUES ($device_id, $date, $first_login, $last_logout, $total_active_seconds, 0);
                ";
                using var insertCmd = new SqliteCommand(insertQuery, connection);
                insertCmd.Parameters.AddWithValue("$device_id", attendance.DeviceId);
                insertCmd.Parameters.AddWithValue("$date", attendance.Date.ToString("yyyy-MM-dd"));
                insertCmd.Parameters.AddWithValue("$first_login", attendance.FirstLogin.ToString("o"));
                insertCmd.Parameters.AddWithValue("$last_logout", attendance.LastLogout.HasValue ? (object)attendance.LastLogout.Value.ToString("o") : DBNull.Value);
                insertCmd.Parameters.AddWithValue("$total_active_seconds", attendance.TotalActiveSeconds);
                await insertCmd.ExecuteNonQueryAsync();
            }
        }

        public async Task<IngestBatch> GetUnsyncedBatchAsync(int maxItems)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            string deviceId = string.Empty;
            
            // 1. Fetch Activity Logs
            var activityLogs = new List<ActivityLog>();
            string selectActivities = "SELECT id, device_id, app_name, window_title, domain, is_idle, activity_score, captured_at FROM activity_logs WHERE synced = 0 LIMIT $limit;";
            using (var cmd = new SqliteCommand(selectActivities, connection))
            {
                cmd.Parameters.AddWithValue("$limit", maxItems);
                using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync())
                {
                    long id = reader.GetInt64(0);
                    deviceId = reader.GetString(1);
                    string? appName = reader.IsDBNull(2) ? null : reader.GetString(2);
                    string? windowTitle = reader.IsDBNull(3) ? null : reader.GetString(3);
                    string? domain = reader.IsDBNull(4) ? null : reader.GetString(4);
                    bool isIdle = reader.GetInt32(5) == 1;
                    int activityScore = reader.GetInt32(6);
                    DateTimeOffset capturedAt = DateTimeOffset.Parse(reader.GetString(7));

                    activityLogs.Add(new ActivityLog(deviceId, appName, windowTitle, domain, isIdle, activityScore, capturedAt));
                }
            }

            // 2. Fetch Screenshots
            var screenshots = new List<ScreenshotRecord>();
            string selectScreenshots = "SELECT id, device_id, captured_at, encrypted_data FROM screenshots WHERE synced = 0 LIMIT $limit;";
            using (var cmd = new SqliteCommand(selectScreenshots, connection))
            {
                cmd.Parameters.AddWithValue("$limit", 10); // Capped at 10 screenshots per batch to prevent huge HTTP requests
                using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync())
                {
                    long id = reader.GetInt64(0);
                    deviceId = reader.GetString(1);
                    DateTimeOffset capturedAt = DateTimeOffset.Parse(reader.GetString(2));
                    byte[] encryptedData = (byte[])reader.GetValue(3);

                    screenshots.Add(new ScreenshotRecord(deviceId, capturedAt, encryptedData));
                }
            }

            // 3. Fetch USB Logs
            var usbLogs = new List<UsbDeviceRecord>();
            string selectUsb = "SELECT id, device_id, device_name, action, captured_at FROM usb_logs WHERE synced = 0 LIMIT $limit;";
            using (var cmd = new SqliteCommand(selectUsb, connection))
            {
                cmd.Parameters.AddWithValue("$limit", maxItems);
                using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync())
                {
                    long id = reader.GetInt64(0);
                    deviceId = reader.GetString(1);
                    string deviceName = reader.GetString(2);
                    string action = reader.GetString(3);
                    DateTimeOffset capturedAt = DateTimeOffset.Parse(reader.GetString(4));

                    usbLogs.Add(new UsbDeviceRecord(deviceId, deviceName, action, capturedAt));
                }
            }

            // 4. Fetch Attendance records
            var attendanceRecords = new List<AttendanceRecord>();
            string selectAttendance = "SELECT id, device_id, date, first_login, last_logout, total_active_seconds FROM attendance WHERE synced = 0 LIMIT $limit;";
            using (var cmd = new SqliteCommand(selectAttendance, connection))
            {
                cmd.Parameters.AddWithValue("$limit", maxItems);
                using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync())
                {
                    long id = reader.GetInt64(0);
                    deviceId = reader.GetString(1);
                    DateOnly date = DateOnly.Parse(reader.GetString(2));
                    DateTimeOffset firstLogin = DateTimeOffset.Parse(reader.GetString(3));
                    DateTimeOffset? lastLogout = reader.IsDBNull(4) ? null : DateTimeOffset.Parse(reader.GetString(4));
                    long totalActiveSeconds = reader.GetInt64(5);

                    attendanceRecords.Add(new AttendanceRecord(deviceId, date, firstLogin, lastLogout, totalActiveSeconds));
                }
            }

            return new IngestBatch(
                DeviceId: deviceId,
                ActivityLogs: activityLogs.ToArray(),
                Screenshots: screenshots.ToArray(),
                UsbLogs: usbLogs.ToArray(),
                AttendanceRecords: attendanceRecords.ToArray()
            );
        }

        public async Task MarkBatchSyncedAsync(IngestBatch batch)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            using var transaction = connection.BeginTransaction();

            try
            {
                // Mark Activity Logs
                if (batch.ActivityLogs.Length > 0)
                {
                    string updateActivity = "UPDATE activity_logs SET synced = 1 WHERE device_id = $device_id AND captured_at = $captured_at;";
                    using var cmd = new SqliteCommand(updateActivity, connection, transaction);
                    var deviceIdParam = cmd.Parameters.Add("$device_id", SqliteType.Text);
                    var capturedAtParam = cmd.Parameters.Add("$captured_at", SqliteType.Text);

                    foreach (var log in batch.ActivityLogs)
                    {
                        deviceIdParam.Value = log.DeviceId;
                        capturedAtParam.Value = log.CapturedAt.ToString("o");
                        await cmd.ExecuteNonQueryAsync();
                    }
                }

                // Mark Screenshots
                if (batch.Screenshots.Length > 0)
                {
                    string updateScreenshots = "UPDATE screenshots SET synced = 1 WHERE device_id = $device_id AND captured_at = $captured_at;";
                    using var cmd = new SqliteCommand(updateScreenshots, connection, transaction);
                    var deviceIdParam = cmd.Parameters.Add("$device_id", SqliteType.Text);
                    var capturedAtParam = cmd.Parameters.Add("$captured_at", SqliteType.Text);

                    foreach (var screenshot in batch.Screenshots)
                    {
                        deviceIdParam.Value = screenshot.DeviceId;
                        capturedAtParam.Value = screenshot.CapturedAt.ToString("o");
                        await cmd.ExecuteNonQueryAsync();
                    }
                }

                // Mark USB Logs
                if (batch.UsbLogs.Length > 0)
                {
                    string updateUsb = "UPDATE usb_logs SET synced = 1 WHERE device_id = $device_id AND captured_at = $captured_at;";
                    using var cmd = new SqliteCommand(updateUsb, connection, transaction);
                    var deviceIdParam = cmd.Parameters.Add("$device_id", SqliteType.Text);
                    var capturedAtParam = cmd.Parameters.Add("$captured_at", SqliteType.Text);

                    foreach (var usb in batch.UsbLogs)
                    {
                        deviceIdParam.Value = usb.DeviceId;
                        capturedAtParam.Value = usb.CapturedAt.ToString("o");
                        await cmd.ExecuteNonQueryAsync();
                    }
                }

                // Mark Attendance Records
                if (batch.AttendanceRecords.Length > 0)
                {
                    string updateAttendance = "UPDATE attendance SET synced = 1 WHERE device_id = $device_id AND date = $date;";
                    using var cmd = new SqliteCommand(updateAttendance, connection, transaction);
                    var deviceIdParam = cmd.Parameters.Add("$device_id", SqliteType.Text);
                    var dateParam = cmd.Parameters.Add("$date", SqliteType.Text);

                    foreach (var att in batch.AttendanceRecords)
                    {
                        deviceIdParam.Value = att.DeviceId;
                        dateParam.Value = att.Date.ToString("yyyy-MM-dd");
                        await cmd.ExecuteNonQueryAsync();
                    }
                }

                await transaction.CommitAsync();
            }
            catch
            {
                await transaction.RollbackAsync();
                throw;
            }
        }

        public async Task PurgeSyncedRecordsAsync(int olderThanDays)
        {
            using var connection = new SqliteConnection(_connectionString);
            await connection.OpenAsync();

            string cutoffDate = DateTimeOffset.UtcNow.AddDays(-olderThanDays).ToString("o");

            string purgeQuery = @"
                DELETE FROM activity_logs WHERE synced = 1 AND captured_at < $cutoff;
                DELETE FROM screenshots WHERE synced = 1 AND captured_at < $cutoff;
                DELETE FROM usb_logs WHERE synced = 1 AND captured_at < $cutoff;
                DELETE FROM attendance WHERE synced = 1 AND date < $cutoff_date;
            ";

            using var command = new SqliteCommand(purgeQuery, connection);
            command.Parameters.AddWithValue("$cutoff", cutoffDate);
            command.Parameters.AddWithValue("$cutoff_date", DateTimeOffset.UtcNow.AddDays(-olderThanDays).ToString("yyyy-MM-dd"));

            await command.ExecuteNonQueryAsync();
        }
    }
}
