using Agent.Core.Consent;
using Agent.Storage.Sqlite;

namespace Agent.Storage.Consent;

public sealed class SqliteConsentStore(ISqliteConnectionFactory connectionFactory) : IConsentStore
{
    public async Task<ConsentRecord?> GetAsync(string userSid, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT user_sid, machine_id, policy_version, acknowledged_at_utc FROM consent_records WHERE user_sid = $sid;";
        command.Parameters.AddWithValue("$sid", userSid);

        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new ConsentRecord(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt32(2),
            DateTimeOffset.Parse(reader.GetString(3), System.Globalization.CultureInfo.InvariantCulture));
    }

    public async Task<ConsentRecord?> GetLatestForMachineAsync(string machineId, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT user_sid, machine_id, policy_version, acknowledged_at_utc
            FROM consent_records
            WHERE machine_id = $machineId
            ORDER BY policy_version DESC
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$machineId", machineId);

        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new ConsentRecord(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt32(2),
            DateTimeOffset.Parse(reader.GetString(3), System.Globalization.CultureInfo.InvariantCulture));
    }

    public async Task SaveAsync(ConsentRecord record, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            INSERT INTO consent_records (user_sid, machine_id, policy_version, acknowledged_at_utc)
            VALUES ($sid, $machineId, $version, $acknowledgedAt)
            ON CONFLICT(user_sid) DO UPDATE SET
                machine_id = excluded.machine_id,
                policy_version = excluded.policy_version,
                acknowledged_at_utc = excluded.acknowledged_at_utc;
            """;
        command.Parameters.AddWithValue("$sid", record.UserSid);
        command.Parameters.AddWithValue("$machineId", record.MachineId);
        command.Parameters.AddWithValue("$version", record.PolicyVersion);
        command.Parameters.AddWithValue("$acknowledgedAt", record.AcknowledgedAtUtc.ToString("O"));

        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }
}
