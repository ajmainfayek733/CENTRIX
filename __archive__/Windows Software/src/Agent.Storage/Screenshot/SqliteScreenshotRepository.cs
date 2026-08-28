using Agent.Collectors.Screenshot;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Agent.Storage.Screenshot;

public sealed class SqliteScreenshotRepository(ISqliteConnectionFactory connectionFactory, ILogger<SqliteScreenshotRepository> logger) : IScreenshotRepository
{
    public async Task SaveAsync(ScreenshotRecord record, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO screenshots
                (client_event_id, machine_id, user_sid, captured_at_utc, width, height, monitor_count, local_encrypted_file_path, encoded_size_bytes)
            VALUES
                ($id, $machineId, $userSid, $capturedAt, $width, $height, $monitorCount, $path, $size)
            ON CONFLICT(client_event_id) DO NOTHING;
            """;
        command.Parameters.AddWithValue("$id", record.ClientEventId.ToString());
        command.Parameters.AddWithValue("$machineId", record.MachineId);
        command.Parameters.AddWithValue("$userSid", record.UserSid);
        command.Parameters.AddWithValue("$capturedAt", record.CapturedAtUtc.ToString("O"));
        command.Parameters.AddWithValue("$width", record.Width);
        command.Parameters.AddWithValue("$height", record.Height);
        command.Parameters.AddWithValue("$monitorCount", record.MonitorCount);
        command.Parameters.AddWithValue("$path", record.LocalEncryptedFilePath);
        command.Parameters.AddWithValue("$size", record.EncodedSizeBytes);

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ScreenshotRecord>> GetPendingUploadsAsync(int maxBatchSize, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM screenshots ORDER BY captured_at_utc LIMIT $limit;";
        command.Parameters.AddWithValue("$limit", maxBatchSize);

        var results = new List<ScreenshotRecord>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            results.Add(new ScreenshotRecord
            {
                ClientEventId = Guid.Parse(reader.GetString(0)),
                MachineId = reader.GetString(1),
                UserSid = reader.GetString(2),
                CapturedAtUtc = DateTimeOffset.Parse(reader.GetString(3), System.Globalization.CultureInfo.InvariantCulture),
                Width = reader.GetInt32(4),
                Height = reader.GetInt32(5),
                MonitorCount = reader.GetInt32(6),
                LocalEncryptedFilePath = reader.GetString(7),
                EncodedSizeBytes = reader.GetInt64(8)
            });
        }

        return results;
    }

    public async Task MarkUploadedAsync(Guid clientEventId, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT local_encrypted_file_path FROM screenshots WHERE client_event_id = $id;";
        command.Parameters.AddWithValue("$id", clientEventId.ToString());
        var filePath = (string?)await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);

        using (var deleteCommand = connection.CreateCommand())
        {
            deleteCommand.CommandText = "DELETE FROM screenshots WHERE client_event_id = $id;";
            deleteCommand.Parameters.AddWithValue("$id", clientEventId.ToString());
            await deleteCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        DeleteLocalFile(filePath);
    }

    public async Task<int> PurgeExpiredUnuploadedAsync(TimeSpan maxAge, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        var cutoff = (DateTimeOffset.UtcNow - maxAge).ToString("O");

        using var selectCommand = connection.CreateCommand();
        selectCommand.CommandText = "SELECT client_event_id, local_encrypted_file_path FROM screenshots WHERE captured_at_utc < $cutoff;";
        selectCommand.Parameters.AddWithValue("$cutoff", cutoff);

        var expired = new List<(string Id, string Path)>();
        using (var reader = await selectCommand.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                expired.Add((reader.GetString(0), reader.GetString(1)));
            }
        }

        using var deleteCommand = connection.CreateCommand();
        deleteCommand.CommandText = "DELETE FROM screenshots WHERE captured_at_utc < $cutoff;";
        deleteCommand.Parameters.AddWithValue("$cutoff", cutoff);
        var deleted = await deleteCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);

        foreach (var (_, path) in expired)
        {
            DeleteLocalFile(path);
        }

        return deleted;
    }

    private void DeleteLocalFile(string? filePath)
    {
        if (string.IsNullOrEmpty(filePath))
        {
            return;
        }

        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch (IOException ex)
        {
            logger.LogWarning(ex, "Failed to delete local screenshot file {FilePath}.", filePath);
        }
    }
}
