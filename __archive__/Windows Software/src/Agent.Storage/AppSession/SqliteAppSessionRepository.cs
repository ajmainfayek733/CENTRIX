using System.Text.Json;
using Agent.Collectors.AppSession;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;

namespace Agent.Storage.AppSession;

public sealed class SqliteAppSessionRepository(ISqliteConnectionFactory connectionFactory) : IAppSessionRepository
{
    public async Task OpenAsync(AppSessionRecord openSession, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO app_sessions
                (client_event_id, machine_id, user_sid, windows_session_id, kind, process_id, executable, window_title, start_time_utc, end_time_utc, productivity_tag)
            VALUES
                ($id, $machineId, $userSid, $sessionId, $kind, $processId, $executable, $windowTitle, $startTime, NULL, $tag)
            ON CONFLICT(client_event_id) DO NOTHING;
            """;
        command.Parameters.AddWithValue("$id", openSession.ClientEventId.ToString());
        command.Parameters.AddWithValue("$machineId", openSession.MachineId);
        command.Parameters.AddWithValue("$userSid", openSession.UserSid);
        command.Parameters.AddWithValue("$sessionId", openSession.WindowsSessionId);
        command.Parameters.AddWithValue("$kind", openSession.Kind.ToString());
        command.Parameters.AddWithValue("$processId", openSession.ProcessId);
        command.Parameters.AddWithValue("$executable", openSession.Executable);
        command.Parameters.AddWithValue("$windowTitle", openSession.WindowTitle);
        command.Parameters.AddWithValue("$startTime", openSession.StartTimeUtc.ToString("O"));
        command.Parameters.AddWithValue("$tag", (object?)openSession.ProductivityTag ?? DBNull.Value);

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task CloseAsync(Guid clientEventId, DateTimeOffset endTimeUtc, string? productivityTag, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();

        AppSessionRecord? completed;
        using (var updateCommand = connection.CreateCommand())
        {
            updateCommand.Transaction = transaction;
            updateCommand.CommandText =
                """
                UPDATE app_sessions
                SET end_time_utc = $endTime, productivity_tag = COALESCE($tag, productivity_tag)
                WHERE client_event_id = $id AND end_time_utc IS NULL;
                """;
            updateCommand.Parameters.AddWithValue("$endTime", endTimeUtc.ToString("O"));
            updateCommand.Parameters.AddWithValue("$tag", (object?)productivityTag ?? DBNull.Value);
            updateCommand.Parameters.AddWithValue("$id", clientEventId.ToString());

            var rowsUpdated = await updateCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            if (rowsUpdated == 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
        }

        completed = await ReadByIdAsync(connection, transaction, clientEventId, cancellationToken).ConfigureAwait(false);

        using (var outboxCommand = connection.CreateCommand())
        {
            outboxCommand.Transaction = transaction;
            outboxCommand.CommandText =
                """
                INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
                VALUES ($id, 'app-session', $payload, 0, $createdAt, 0);
                """;
            outboxCommand.Parameters.AddWithValue("$id", clientEventId.ToString());
            outboxCommand.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(completed));
            outboxCommand.Parameters.AddWithValue("$createdAt", endTimeUtc.ToString("O"));

            await outboxCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<AppSessionRecord>> GetOpenSessionsAsync(CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT client_event_id, machine_id, user_sid, windows_session_id, kind, process_id, executable, window_title, start_time_utc, end_time_utc, productivity_tag
            FROM app_sessions
            WHERE end_time_utc IS NULL;
            """;

        var results = new List<AppSessionRecord>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            results.Add(Map(reader));
        }

        return results;
    }

    private static async Task<AppSessionRecord?> ReadByIdAsync(SqliteConnection connection, SqliteTransaction transaction, Guid clientEventId, CancellationToken cancellationToken)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            """
            SELECT client_event_id, machine_id, user_sid, windows_session_id, kind, process_id, executable, window_title, start_time_utc, end_time_utc, productivity_tag
            FROM app_sessions
            WHERE client_event_id = $id;
            """;
        command.Parameters.AddWithValue("$id", clientEventId.ToString());

        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false) ? Map(reader) : null;
    }

    private static AppSessionRecord Map(SqliteDataReader reader) => new()
    {
        ClientEventId = Guid.Parse(reader.GetString(0)),
        MachineId = reader.GetString(1),
        UserSid = reader.GetString(2),
        WindowsSessionId = reader.GetInt32(3),
        Kind = Enum.Parse<AppSessionKind>(reader.GetString(4)),
        ProcessId = reader.GetInt32(5),
        Executable = reader.GetString(6),
        WindowTitle = reader.GetString(7),
        StartTimeUtc = DateTimeOffset.Parse(reader.GetString(8), System.Globalization.CultureInfo.InvariantCulture),
        EndTimeUtc = reader.IsDBNull(9) ? null : DateTimeOffset.Parse(reader.GetString(9), System.Globalization.CultureInfo.InvariantCulture),
        ProductivityTag = reader.IsDBNull(10) ? null : reader.GetString(10)
    };
}
