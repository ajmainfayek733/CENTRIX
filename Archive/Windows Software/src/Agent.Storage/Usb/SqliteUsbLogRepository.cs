using System.Text.Json;
using Agent.Collectors.Usb;
using Agent.Native;
using Agent.Storage.Sqlite;
using Microsoft.Data.Sqlite;

namespace Agent.Storage.Usb;

public sealed class SqliteUsbLogRepository(ISqliteConnectionFactory connectionFactory) : IUsbLogRepository
{
    public async Task<IReadOnlyDictionary<string, UsbDriveSnapshot>> GetCurrentlyPresentAsync(CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText =
            """
            SELECT pnp_device_id, serial_number, model, manufacturer, capacity_bytes, volumes_json, event_type
            FROM usb_events
            WHERE (pnp_device_id, occurred_at_utc) IN (
                SELECT pnp_device_id, MAX(occurred_at_utc)
                FROM usb_events
                GROUP BY pnp_device_id
            );
            """;

        var results = new Dictionary<string, UsbDriveSnapshot>();
        using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var eventType = Enum.Parse<UsbEventType>(reader.GetString(6));
            if (eventType == UsbEventType.Removed)
            {
                continue;
            }

            var pnpDeviceId = reader.GetString(0);
            results[pnpDeviceId] = new UsbDriveSnapshot(
                pnpDeviceId,
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetInt64(4),
                JsonSerializer.Deserialize<List<UsbVolumeSnapshot>>(reader.GetString(5)) ?? []);
        }

        return results;
    }

    public async Task RecordEventAsync(UsbDeviceEvent deviceEvent, CancellationToken cancellationToken)
    {
        using var connection = connectionFactory.CreateOpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var insertCommand = connection.CreateCommand())
        {
            insertCommand.Transaction = transaction;
            insertCommand.CommandText =
                """
                INSERT INTO usb_events
                    (client_event_id, machine_id, user_sid, pnp_device_id, serial_number, model, manufacturer, capacity_bytes, volumes_json, event_type, occurred_at_utc)
                VALUES
                    ($id, $machineId, $userSid, $pnpDeviceId, $serial, $model, $manufacturer, $capacity, $volumes, $eventType, $occurredAt);
                """;
            insertCommand.Parameters.AddWithValue("$id", deviceEvent.ClientEventId.ToString());
            insertCommand.Parameters.AddWithValue("$machineId", deviceEvent.MachineId);
            insertCommand.Parameters.AddWithValue("$userSid", deviceEvent.UserSid);
            insertCommand.Parameters.AddWithValue("$pnpDeviceId", deviceEvent.PnpDeviceId);
            insertCommand.Parameters.AddWithValue("$serial", (object?)deviceEvent.SerialNumber ?? DBNull.Value);
            insertCommand.Parameters.AddWithValue("$model", (object?)deviceEvent.Model ?? DBNull.Value);
            insertCommand.Parameters.AddWithValue("$manufacturer", (object?)deviceEvent.Manufacturer ?? DBNull.Value);
            insertCommand.Parameters.AddWithValue("$capacity", (object?)deviceEvent.CapacityBytes ?? DBNull.Value);
            insertCommand.Parameters.AddWithValue("$volumes", JsonSerializer.Serialize(deviceEvent.Volumes));
            insertCommand.Parameters.AddWithValue("$eventType", deviceEvent.EventType.ToString());
            insertCommand.Parameters.AddWithValue("$occurredAt", deviceEvent.OccurredAtUtc.ToString("O"));

            await insertCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        using (var outboxCommand = connection.CreateCommand())
        {
            outboxCommand.Transaction = transaction;
            outboxCommand.CommandText =
                """
                INSERT INTO outbox (client_event_id, channel, payload_json, priority, created_at_utc, attempts)
                VALUES ($id, 'usb-device', $payload, $priority, $createdAt, 0);
                """;
            outboxCommand.Parameters.AddWithValue("$id", deviceEvent.ClientEventId.ToString());
            outboxCommand.Parameters.AddWithValue("$payload", JsonSerializer.Serialize(deviceEvent));
            outboxCommand.Parameters.AddWithValue("$priority", (int)((Agent.Core.Sync.ISyncableEvent)deviceEvent).Priority);
            outboxCommand.Parameters.AddWithValue("$createdAt", deviceEvent.OccurredAtUtc.ToString("O"));

            await outboxCommand.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }
}
