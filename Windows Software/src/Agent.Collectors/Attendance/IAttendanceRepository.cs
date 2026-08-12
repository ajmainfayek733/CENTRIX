namespace Agent.Collectors.Attendance;

public interface IAttendanceRepository
{
    /// <summary>
    /// Persists the raw event and enqueues it on the sync outbox in the same local transaction.
    /// Idempotent on <see cref="AttendanceRawEvent.ClientEventId"/> - re-appending an event
    /// already stored is a silent no-op, which absorbs Windows APIs occasionally firing
    /// duplicate notifications.
    /// </summary>
    Task AppendEventAsync(AttendanceRawEvent rawEvent, CancellationToken cancellationToken);

    Task<IReadOnlyList<AttendanceRawEvent>> GetEventsAsync(DateTimeOffset? sinceUtc, CancellationToken cancellationToken);
}
