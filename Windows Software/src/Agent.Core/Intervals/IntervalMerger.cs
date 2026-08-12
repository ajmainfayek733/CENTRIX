namespace Agent.Core.Intervals;

/// <summary>
/// Merges overlapping intervals (e.g. Idle and Locked periods that cover the same span) so
/// callers never double-subtract the same wall-clock time twice - the root cause called out
/// in the Attendance spec's "Locked time overlaps idle time" edge case.
/// </summary>
public static class IntervalMerger
{
    public static IReadOnlyList<TimeInterval> Merge(IEnumerable<TimeInterval> intervals)
    {
        var ordered = intervals.OrderBy(i => i.Start).ToList();
        if (ordered.Count == 0)
        {
            return [];
        }

        var merged = new List<TimeInterval>(ordered.Count);
        var current = ordered[0];

        for (var i = 1; i < ordered.Count; i++)
        {
            var next = ordered[i];
            if (next.Start <= current.End)
            {
                if (next.End > current.End)
                {
                    current = new TimeInterval(current.Start, next.End);
                }
            }
            else
            {
                merged.Add(current);
                current = next;
            }
        }

        merged.Add(current);
        return merged;
    }

    public static TimeSpan TotalDuration(IEnumerable<TimeInterval> intervals) =>
        Merge(intervals).Aggregate(TimeSpan.Zero, (total, interval) => total + interval.Duration);
}
