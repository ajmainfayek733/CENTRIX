using Agent.Core.Sync;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;

namespace Agent.Storage.Outbox;

public sealed class SqliteOutboxRepository(ISqliteConnectionFactory connectionFactory) : IOutboxRepository
{
    public async Task EnqueueAsync(ISyncableEvent syncableEvent, string payloadJson, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
            VALUES ($id, $channel, $payload, $priority, $createdAt, 0)
            ON CONFLICT(client_event_id) DO NOTHING;
            """;
        command.Parameters.AddWithValue("$id", syncableEvent.ClientEventId.ToString());
        command.Parameters.AddWithValue("$channel", syncableEvent.Channel);
        command.Parameters.AddWithValue("$payload", payloadJson);
        command.Parameters.AddWithValue("$priority", (int)syncableEvent.Priority);
        command.Parameters.AddWithValue("$createdAt", syncableEvent.OccurredAtUtc.ToString("O"));

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<OutboxRecord>> GetPendingAsync(string channel, int maxBatchSize, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT client_event_id, channel, payload_json, priority, created_at_utc, attempts
            FROM outbox
            WHERE channel = $channel
            ORDER BY created_at_utc
            LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$channel", channel);
        command.Parameters.AddWithValue("$limit", maxBatchSize);

        var results = new List<OutboxRecord>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            results.Add(new OutboxRecord(
                Guid.Parse(reader.GetString(0)),
                reader.GetString(1),
                reader.GetString(2),
                (SyncPriority)reader.GetInt32(3),
                DateTimeOffset.Parse(reader.GetString(4), System.Globalization.CultureInfo.InvariantCulture),
                reader.GetInt32(5)));
        }

        return results;
    }

    public async Task MarkSyncedAsync(IReadOnlyList<Guid> clientEventIds, CancellationToken cancellationToken)
    {
        if (clientEventIds.Count == 0)
        {
            return;
        }

        // Retention policy: delete immediately on backend acknowledgement rather than soft-marking.
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "DELETE FROM outbox WHERE client_event_id = $id;";
        var idParam = command.Parameters.Add("$id", SqliteType.Text);

        foreach (var id in clientEventIds)
        {
            idParam.Value = id.ToString();
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task IncrementAttemptsAsync(IReadOnlyList<Guid> clientEventIds, CancellationToken cancellationToken)
    {
        if (clientEventIds.Count == 0)
        {
            return;
        }

        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "UPDATE outbox SET attempts = attempts + 1 WHERE client_event_id = $id;";
        var idParam = command.Parameters.Add("$id", SqliteType.Text);

        foreach (var id in clientEventIds)
        {
            idParam.Value = id.ToString();
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<int> PurgeExpiredUnsyncedAsync(TimeSpan maxAge, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM outbox WHERE created_at_utc < $cutoff;";
        command.Parameters.AddWithValue("$cutoff", (DateTimeOffset.UtcNow - maxAge).ToString("O"));

        return await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<string>> GetPendingChannelsAsync(CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT DISTINCT channel FROM outbox;";

        var channels = new List<string>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            channels.Add(reader.GetString(0));
        }

        return channels;
    }
}
