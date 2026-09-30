using System.Text.Json;
using Agent.Collectors.Attendance;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;

namespace Agent.Storage.Attendance;

/// <summary>
/// Writes the domain row and the outbox row in a single local transaction (the outbox pattern),
/// so a crash between the two writes is impossible - either both are durable or neither is.
/// </summary>
public sealed class SqliteAttendanceRepository(ISqliteConnectionFactory connectionFactory) : IAttendanceRepository
{
    public async Task AppendEventAsync(AttendanceRawEvent rawEvent, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var insertEvent = connection.CreateCommand())
        {
            insertEvent.Transaction = transaction;
            insertEvent.CommandText =
                """
                INSERT INTO attendance_events
                    (client_event_id, machine_id, user_sid, session_id, is_remote_session, event_type, occurred_at_utc, reason)
                VALUES
                    ($id, $machineId, $userSid, $sessionId, $isRemote, $eventType, $occurredAt, $reason)
                ON CONFLICT(client_event_id) DO NOTHING;
                """;
            insertEvent.Parameters.AddWithValue("$id", rawEvent.ClientEventId.ToString());
            insertEvent.Parameters.AddWithValue("$machineId", rawEvent.MachineId);
            insertEvent.Parameters.AddWithValue("$userSid", rawEvent.UserSid);
            insertEvent.Parameters.AddWithValue("$sessionId", rawEvent.SessionId);
            insertEvent.Parameters.AddWithValue("$isRemote", rawEvent.IsRemoteSession ? 1 : 0);
            insertEvent.Parameters.AddWithValue("$eventType", rawEvent.EventType.ToString());
            insertEvent.Parameters.AddWithValue("$occurredAt", rawEvent.OccurredAtUtc.ToString("O"));
            insertEvent.Parameters.AddWithValue("$reason", (object?)rawEvent.Reason ?? DBNull.Value);

            var rowsInserted = await insertEvent.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            if (rowsInserted == 0)
            {
                // Duplicate ClientEventId - Windows APIs occasionally fire the same
                // notification twice. Already recorded, nothing more to do.
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
        }

        using (var insertOutbox = connection.CreateCommand())
        {
            insertOutbox.Transaction = transaction;
            insertOutbox.CommandText =
                """
                INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
                VALUES ($id, 'attendance', $payload, 0, $createdAt, 0);
                """;
            insertOutbox.Parameters.AddWithValue("$id", rawEvent.ClientEventId.ToString());
            insertOutbox.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(rawEvent));
            insertOutbox.Parameters.AddWithValue("$createdAt", rawEvent.OccurredAtUtc.ToString("O"));

            await insertOutbox.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<AttendanceRawEvent>> GetEventsAsync(DateTimeOffset? sinceUtc, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = sinceUtc is null
            ? "SELECT client_event_id, machine_id, user_sid, session_id, is_remote_session, event_type, occurred_at_utc, reason FROM attendance_events ORDER BY occurred_at_utc;"
            : "SELECT client_event_id, machine_id, user_sid, session_id, is_remote_session, event_type, occurred_at_utc, reason FROM attendance_events WHERE occurred_at_utc >= $since ORDER BY occurred_at_utc;";

        if (sinceUtc is { } since)
        {
            command.Parameters.AddWithValue("$since", since.ToString("O"));
        }

        var results = new List<AttendanceRawEvent>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            results.Add(new AttendanceRawEvent
            {
                ClientEventId = Guid.Parse(reader.GetString(0)),
                MachineId = reader.GetString(1),
                UserSid = reader.GetString(2),
                SessionId = reader.GetInt32(3),
                IsRemoteSession = reader.GetInt32(4) != 0,
                EventType = Enum.Parse<AttendanceEventType>(reader.GetString(5)),
                OccurredAtUtc = DateTimeOffset.Parse(reader.GetString(6), System.Globalization.CultureInfo.InvariantCulture),
                Reason = reader.IsDBNull(7) ? null : reader.GetString(7)
            });
        }

        return results;
    }
}
