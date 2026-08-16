using System.Text.Json;
using Agent.Collectors.Activity;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;

namespace Agent.Storage.Activity;

public sealed class SqliteActivityRepository(ISqliteConnectionFactory connectionFactory) : IActivityRepository
{
    public async Task OpenAsync(ActivitySessionRecord openSession, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO activity_sessions (client_event_id, machine_id, user_sid, state, reason, start_time_utc, end_time_utc)
            VALUES ($id, $machineId, $userSid, $state, $reason, $startTime, NULL)
            ON CONFLICT(client_event_id) DO NOTHING;
            """;
        command.Parameters.AddWithValue("$id", openSession.ClientEventId.ToString());
        command.Parameters.AddWithValue("$machineId", openSession.MachineId);
        command.Parameters.AddWithValue("$userSid", openSession.UserSid);
        command.Parameters.AddWithValue("$state", openSession.State.ToString());
        command.Parameters.AddWithValue("$reason", openSession.Reason.ToString());
        command.Parameters.AddWithValue("$startTime", openSession.StartTimeUtc.ToString("O"));

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task CloseAsync(Guid clientEventId, DateTimeOffset endTimeUtc, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var updateCommand = connection.CreateCommand())
        {
            updateCommand.Transaction = transaction;
            updateCommand.CommandText = "UPDATE activity_sessions SET end_time_utc = $endTime WHERE client_event_id = $id AND end_time_utc IS NULL;";
            updateCommand.Parameters.AddWithValue("$endTime", endTimeUtc.ToString("O"));
            updateCommand.Parameters.AddWithValue("$id", clientEventId.ToString());

            var rowsUpdated = await updateCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            if (rowsUpdated == 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
        }

        var completed = await ReadByIdAsync(connection, transaction, clientEventId, cancellationToken).ConfigureAwait(false);

        using (var outboxCommand = connection.CreateCommand())
        {
            outboxCommand.Transaction = transaction;
            outboxCommand.CommandText =
                """
                INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
                VALUES ($id, 'activity-session', $payload, 0, $createdAt, 0);
                """;
            outboxCommand.Parameters.AddWithValue("$id", clientEventId.ToString());
            outboxCommand.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(completed));
            outboxCommand.Parameters.AddWithValue("$createdAt", endTimeUtc.ToString("O"));

            await outboxCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ActivitySessionRecord>> GetOpenSessionsAsync(CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT client_event_id, machine_id, user_sid, state, reason, start_time_utc, end_time_utc
            FROM activity_sessions
            WHERE end_time_utc IS NULL;
            """;

        var results = new List<ActivitySessionRecord>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            results.Add(Map(reader));
        }

        return results;
    }

    private static async Task<ActivitySessionRecord?> ReadByIdAsync(SqliteConnection connection, SqliteTransaction transaction, Guid clientEventId, CancellationToken cancellationToken)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            """
            SELECT client_event_id, machine_id, user_sid, state, reason, start_time_utc, end_time_utc
            FROM activity_sessions
            WHERE client_event_id = $id;
            """;
        command.Parameters.AddWithValue("$id", clientEventId.ToString());

        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false) ? Map(reader) : null;
    }

    private static ActivitySessionRecord Map(SqliteDataReader reader) => new()
    {
        ClientEventId = Guid.Parse(reader.GetString(0)),
        MachineId = reader.GetString(1),
        UserSid = reader.GetString(2),
        State = Enum.Parse<ActivityState>(reader.GetString(3)),
        Reason = Enum.Parse<ActivityReason>(reader.GetString(4)),
        StartTimeUtc = DateTimeOffset.Parse(reader.GetString(5), System.Globalization.CultureInfo.InvariantCulture),
        EndTimeUtc = reader.IsDBNull(6) ? null : DateTimeOffset.Parse(reader.GetString(6), System.Globalization.CultureInfo.InvariantCulture)
    };
}
