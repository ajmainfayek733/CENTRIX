namespace Agent.Core.Intervals;

public readonly record struct TimeInterval
{
    public TimeInterval(DateTimeOffset start, DateTimeOffset end)
    {
        if (end < start)
        {
            throw new ArgumentOutOfRangeException(nameof(end), end, "Interval end cannot precede start.");
        }

        Start = start;
        End = end;
    }

    public DateTimeOffset Start { get; }

    public DateTimeOffset End { get; }

    public TimeSpan Duration => End - Start;

    public bool Overlaps(TimeInterval other) => Start < other.End && other.Start < End;
}
