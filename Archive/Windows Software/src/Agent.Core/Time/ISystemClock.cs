namespace Agent.Core.Time;

/// <summary>
/// UTC wall-clock time is authoritative for storage; monotonic time is authoritative for
/// duration math, since wall-clock can jump backward/forward (DST, NTP sync, manual changes).
/// </summary>
public interface ISystemClock
{
    DateTimeOffset UtcNow { get; }

    long MonotonicMilliseconds { get; }
}
