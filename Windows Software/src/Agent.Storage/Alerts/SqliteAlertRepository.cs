using System.Text.Json;
using Agent.Alerts;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;

namespace Agent.Storage.Alerts;

public sealed class SqliteAlertRepository(ISqliteConnectionFactory connectionFactory) : IAlertRepository
{
    public async Task<AlertRecord?> FindOpenAlertAsync(string machineId, string userSid, AlertType type, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT * FROM alerts
            WHERE machine_id = $machineId AND user_sid = $userSid AND type = $type AND resolved_at_utc IS NULL
            ORDER BY triggered_at_utc DESC
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$machineId", machineId);
        command.Parameters.AddWithValue("$userSid", userSid);
        command.Parameters.AddWithValue("$type", type.ToString());

        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false) ? Map(reader) : null;
    }

    public async Task<IReadOnlyList<AlertRecord>> GetDueForNotificationAsync(DateTimeOffset nowUtc, TimeSpan renotifyInterval, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT * FROM alerts
            WHERE resolved_at_utc IS NULL
              AND (last_notified_at_utc IS NULL OR last_notified_at_utc <= $cutoff)
            ORDER BY triggered_at_utc;
            """;
        command.Parameters.AddWithValue("$cutoff", (nowUtc - renotifyInterval).ToString("O"));

        var results = new List<AlertRecord>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            results.Add(Map(reader));
        }

        return results;
    }

    public async Task SaveNewAsync(AlertRecord alert, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var insertCommand = connection.CreateCommand())
        {
            insertCommand.Transaction = transaction;
            insertCommand.CommandText =
                """
                INSERT INTO alerts
                    (client_event_id, machine_id, user_sid, type, severity, state, title, message, context_json,
                     triggered_at_utc, acknowledged_at_utc, resolved_at_utc, last_notified_at_utc, escalation_level, notification_count)
                VALUES
                    ($id, $machineId, $userSid, $type, $severity, $state, $title, $message, $context,
                     $triggeredAt, NULL, NULL, NULL, $escalation, 0);
                """;
            insertCommand.Parameters.AddWithValue("$id", alert.ClientEventId.ToString());
            insertCommand.Parameters.AddWithValue("$machineId", alert.MachineId);
            insertCommand.Parameters.AddWithValue("$userSid", alert.UserSid);
            insertCommand.Parameters.AddWithValue("$type", alert.Type.ToString());
            insertCommand.Parameters.AddWithValue("$severity", alert.Severity.ToString());
            insertCommand.Parameters.AddWithValue("$state", alert.State.ToString());
            insertCommand.Parameters.AddWithValue("$title", alert.Title);
            insertCommand.Parameters.AddWithValue("$message", alert.Message);
            insertCommand.Parameters.AddWithValue("$context", alert.ContextJson);
            insertCommand.Parameters.AddWithValue("$triggeredAt", alert.TriggeredAtUtc.ToString("O"));
            insertCommand.Parameters.AddWithValue("$escalation", alert.EscalationLevel);

            await insertCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        using (var outboxCommand = connection.CreateCommand())
        {
            outboxCommand.Transaction = transaction;
            outboxCommand.CommandText =
                """
                INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
                VALUES ($id, 'alert', $payload, 0, $createdAt, 0);
                """;
            outboxCommand.Parameters.AddWithValue("$id", alert.ClientEventId.ToString());
            outboxCommand.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(alert));
            outboxCommand.Parameters.AddWithValue("$createdAt", alert.TriggeredAtUtc.ToString("O"));

            await outboxCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task EscalateAsync(Guid alertId, AlertSeverity newSeverity, string message, DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            UPDATE alerts
            SET severity = $severity, message = $message, escalation_level = escalation_level + 1, state = $state
            WHERE client_event_id = $id;
            """;
        command.Parameters.AddWithValue("$severity", newSeverity.ToString());
        command.Parameters.AddWithValue("$message", message);
        command.Parameters.AddWithValue("$state", AlertState.New.ToString());
        command.Parameters.AddWithValue("$id", alertId.ToString());

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task RecordNotificationAsync(Guid alertId, DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            UPDATE alerts
            SET last_notified_at_utc = $now, notification_count = notification_count + 1,
                state = CASE WHEN state = 'New' THEN 'Shown' ELSE state END
            WHERE client_event_id = $id;
            """;
        command.Parameters.AddWithValue("$now", atUtc.ToString("O"));
        command.Parameters.AddWithValue("$id", alertId.ToString());

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task AcknowledgeAsync(Guid alertId, DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE alerts SET acknowledged_at_utc = $now, state = $state WHERE client_event_id = $id;";
        command.Parameters.AddWithValue("$now", atUtc.ToString("O"));
        command.Parameters.AddWithValue("$state", AlertState.Acknowledged.ToString());
        command.Parameters.AddWithValue("$id", alertId.ToString());

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task ResolveAsync(Guid alertId, DateTimeOffset atUtc, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE alerts SET resolved_at_utc = $now, state = $state WHERE client_event_id = $id;";
        command.Parameters.AddWithValue("$now", atUtc.ToString("O"));
        command.Parameters.AddWithValue("$state", AlertState.Resolved.ToString());
        command.Parameters.AddWithValue("$id", alertId.ToString());

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private static AlertRecord Map(SqliteDataReader reader) => new()
    {
        ClientEventId = Guid.Parse(reader.GetString(0)),
        MachineId = reader.GetString(1),
        UserSid = reader.GetString(2),
        Type = Enum.Parse<AlertType>(reader.GetString(3)),
        Severity = Enum.Parse<AlertSeverity>(reader.GetString(4)),
        State = Enum.Parse<AlertState>(reader.GetString(5)),
        Title = reader.GetString(6),
        Message = reader.GetString(7),
        ContextJson = reader.GetString(8),
        TriggeredAtUtc = DateTimeOffset.Parse(reader.GetString(9), System.Globalization.CultureInfo.InvariantCulture),
        AcknowledgedAtUtc = reader.IsDBNull(10) ? null : DateTimeOffset.Parse(reader.GetString(10), System.Globalization.CultureInfo.InvariantCulture),
        ResolvedAtUtc = reader.IsDBNull(11) ? null : DateTimeOffset.Parse(reader.GetString(11), System.Globalization.CultureInfo.InvariantCulture),
        LastNotifiedAtUtc = reader.IsDBNull(12) ? null : DateTimeOffset.Parse(reader.GetString(12), System.Globalization.CultureInfo.InvariantCulture),
        EscalationLevel = reader.GetInt32(13),
        NotificationCount = reader.GetInt32(14)
    };
}
