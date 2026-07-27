using System.Text.Json;
using Agent.Collectors.Browser;
using Agent.Storage.Sqlite;

namespace Agent.Storage.Browser;

public sealed class SqliteBrowserMonitorRepository(ISqliteConnectionFactory connectionFactory) : IBrowserMonitorRepository
{
    public async Task RecordAsync(BrowserNavigationEvent navigationEvent, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var insertCommand = connection.CreateCommand())
        {
            insertCommand.Transaction = transaction;
            insertCommand.CommandText =
                """
                INSERT INTO browser_navigations
                    (client_event_id, machine_id, user_sid, browser, raw_url, normalized_url, domain, category, occurred_at_utc)
                VALUES
                    ($id, $machineId, $userSid, $browser, $rawUrl, $normalizedUrl, $domain, $category, $occurredAt)
                ON CONFLICT(client_event_id) DO NOTHING;
                """;
            insertCommand.Parameters.AddWithValue("$id", navigationEvent.ClientEventId.ToString());
            insertCommand.Parameters.AddWithValue("$machineId", navigationEvent.MachineId);
            insertCommand.Parameters.AddWithValue("$userSid", navigationEvent.UserSid);
            insertCommand.Parameters.AddWithValue("$browser", navigationEvent.Browser.ToString());
            insertCommand.Parameters.AddWithValue("$rawUrl", navigationEvent.RawUrl);
            insertCommand.Parameters.AddWithValue("$normalizedUrl", (object?)navigationEvent.NormalizedUrl ?? DBNull.Value);
            insertCommand.Parameters.AddWithValue("$domain", (object?)navigationEvent.Domain ?? DBNull.Value);
            insertCommand.Parameters.AddWithValue("$category", navigationEvent.Category.ToString());
            insertCommand.Parameters.AddWithValue("$occurredAt", navigationEvent.OccurredAtUtc.ToString("O"));

            var rowsInserted = await insertCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            if (rowsInserted == 0)
            {
                await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
        }

        using (var outboxCommand = connection.CreateCommand())
        {
            outboxCommand.Transaction = transaction;
            outboxCommand.CommandText =
                """
                INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
                VALUES ($id, 'browser-navigation', $payload, 0, $createdAt, 0);
                """;
            outboxCommand.Parameters.AddWithValue("$id", navigationEvent.ClientEventId.ToString());
            outboxCommand.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(navigationEvent));
            outboxCommand.Parameters.AddWithValue("$createdAt", navigationEvent.OccurredAtUtc.ToString("O"));

            await outboxCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }
}
