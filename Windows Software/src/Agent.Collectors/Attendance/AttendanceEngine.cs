using Agent.Core.Intervals;

namespace Agent.Collectors.Attendance;

/// <summary>
/// Pure, deterministic state machine: raw events in, session records out. Treats attendance as
/// an event-driven state machine rather than accumulated counters, per the Attendance spec's
/// enterprise recommendation. Contains no I/O so it is fully unit-testable.
/// </summary>
public sealed class AttendanceEngine
{
    /// <param name="events">All raw events, any session, any order.</param>
    /// <param name="recoveryCloseAtUtc">
    /// When supplied, any session left open at the end of its event stream is closed at this
    /// timestamp instead of being returned as open — used only by startup crash recovery.
    /// </param>
    public static IReadOnlyList<SessionAttendanceRecord> BuildSessions(
        IEnumerable<AttendanceRawEvent> events,
        DateTimeOffset? recoveryCloseAtUtc = null)
    {
        var sessions = new List<SessionAttendanceRecord>();

        foreach (var group in events.GroupBy(e => e.SessionId))
        {
            // At an identical timestamp, a session-boundary event must resolve deterministically
            // relative to state events: Login always opens the session before any Lock/Idle/Sleep
            // signal is applied, and Logout always closes it after. Without this, GUID-based
            // tie-breaking could process e.g. IdleStart before the Login that opens its session,
            // silently dropping the signal.
            var ordered = group
                .OrderBy(e => e.OccurredAtUtc)
                .ThenBy(e => EventOrderingPriority(e.EventType))
                .ThenBy(e => e.ClientEventId)
                .ToList();

            sessions.AddRange(BuildSessionsForOneWindowsSession(ordered, recoveryCloseAtUtc));
        }

        return sessions.OrderBy(s => s.StartUtc).ToList();
    }

    private static int EventOrderingPriority(AttendanceEventType eventType) => eventType switch
    {
        AttendanceEventType.Login => 0,
        AttendanceEventType.Logout => 2,
        _ => 1
    };

    private static List<SessionAttendanceRecord> BuildSessionsForOneWindowsSession(
        IReadOnlyList<AttendanceRawEvent> orderedEvents,
        DateTimeOffset? recoveryCloseAtUtc)
    {
        var results = new List<SessionAttendanceRecord>();
        SessionBuilder? current = null;

        foreach (var evt in orderedEvents)
        {
            switch (evt.EventType)
            {
                case AttendanceEventType.Login:
                    if (current is not null)
                    {
                        // Dangling open session (missed/duplicate logout) — close it here
                        // rather than merge, so two logins never overlap in one record.
                        results.Add(current.Close(evt.OccurredAtUtc));
                    }

                    current = new SessionBuilder(evt);
                    break;

                case AttendanceEventType.Logout:
                    if (current is not null)
                    {
                        results.Add(current.Close(evt.OccurredAtUtc));
                        current = null;
                    }

                    break;

                case AttendanceEventType.Lock:
                    current?.OpenNonWorking(AttendanceEventType.Lock, evt.OccurredAtUtc);
                    break;
                case AttendanceEventType.IdleStart:
                    current?.OpenNonWorking(AttendanceEventType.IdleStart, evt.OccurredAtUtc);
                    break;
                case AttendanceEventType.SleepStart:
                    current?.OpenNonWorking(AttendanceEventType.SleepStart, evt.OccurredAtUtc);
                    break;

                case AttendanceEventType.Unlock:
                    current?.CloseNonWorking(AttendanceEventType.Lock, evt.OccurredAtUtc);
                    break;
                case AttendanceEventType.IdleEnd:
                    current?.CloseNonWorking(AttendanceEventType.IdleStart, evt.OccurredAtUtc);
                    break;
                case AttendanceEventType.SleepEnd:
                    current?.CloseNonWorking(AttendanceEventType.SleepStart, evt.OccurredAtUtc);
                    break;

                default:
                    throw new ArgumentOutOfRangeException(nameof(orderedEvents), evt.EventType, "Unknown attendance event type.");
            }
        }

        if (current is not null)
        {
            results.Add(recoveryCloseAtUtc is { } closeAt ? current.Close(closeAt) : current.AsOpen());
        }

        return results;
    }

    /// <summary>
    /// Idle, Lock, and Sleep can be concurrently active (e.g. the machine is locked and idle at
    /// once) and each has its own start/end pair. A single "is something non-working active"
    /// flag would let one source's End event incorrectly close an interval another source is
    /// still holding open, so each source is tracked independently in <see cref="_activeSources"/>
    /// — the merged interval only closes once every source that opened it has also closed.
    /// </summary>
    private sealed class SessionBuilder(AttendanceRawEvent loginEvent)
    {
        private readonly List<TimeInterval> _closedNonWorking = [];
        private readonly HashSet<AttendanceEventType> _activeSources = [];
        private DateTimeOffset? _openNonWorkingStart;

        public void OpenNonWorking(AttendanceEventType source, DateTimeOffset atUtc)
        {
            if (_activeSources.Add(source) && _activeSources.Count == 1)
            {
                _openNonWorkingStart = atUtc;
            }
        }

        public void CloseNonWorking(AttendanceEventType source, DateTimeOffset atUtc)
        {
            if (!_activeSources.Remove(source) || _activeSources.Count > 0)
            {
                return;
            }

            if (_openNonWorkingStart is { } start && atUtc > start)
            {
                _closedNonWorking.Add(new TimeInterval(start, atUtc));
            }

            _openNonWorkingStart = null;
        }

        private void ForceCloseAll(DateTimeOffset atUtc)
        {
            if (_openNonWorkingStart is { } start && atUtc > start)
            {
                _closedNonWorking.Add(new TimeInterval(start, atUtc));
            }

            _openNonWorkingStart = null;
            _activeSources.Clear();
        }

        public SessionAttendanceRecord Close(DateTimeOffset endUtc)
        {
            ForceCloseAll(endUtc);

            return new SessionAttendanceRecord
            {
                SessionId = loginEvent.SessionId,
                UserSid = loginEvent.UserSid,
                MachineId = loginEvent.MachineId,
                StartUtc = loginEvent.OccurredAtUtc,
                EndUtc = endUtc,
                NonWorkingIntervals = _closedNonWorking
            };
        }

        public SessionAttendanceRecord AsOpen() => new()
        {
            SessionId = loginEvent.SessionId,
            UserSid = loginEvent.UserSid,
            MachineId = loginEvent.MachineId,
            StartUtc = loginEvent.OccurredAtUtc,
            EndUtc = null,
            NonWorkingIntervals = _closedNonWorking
        };
    }
}
