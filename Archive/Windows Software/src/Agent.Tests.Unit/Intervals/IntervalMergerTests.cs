using Agent.Core.Intervals;

namespace Agent.Tests.Unit.Intervals;

public class IntervalMergerTests
{
    [Fact]
    public void OverlappingIntervals_MergeIntoOne()
    {
        var t0 = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var intervals = new[]
        {
            new TimeInterval(t0, t0.AddMinutes(30)),
            new TimeInterval(t0.AddMinutes(10), t0.AddMinutes(35))
        };

        var merged = IntervalMerger.Merge(intervals);

        var single = Assert.Single(merged);
        Assert.Equal(t0, single.Start);
        Assert.Equal(t0.AddMinutes(35), single.End);
    }

    [Fact]
    public void NonOverlappingIntervals_StayDistinct()
    {
        var t0 = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var intervals = new[]
        {
            new TimeInterval(t0, t0.AddMinutes(10)),
            new TimeInterval(t0.AddMinutes(20), t0.AddMinutes(30))
        };

        var merged = IntervalMerger.Merge(intervals);

        Assert.Equal(2, merged.Count);
    }

    [Fact]
    public void TotalDuration_OfOverlappingIntervals_CountsOverlapOnce()
    {
        var t0 = new DateTimeOffset(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
        var intervals = new[]
        {
            new TimeInterval(t0, t0.AddMinutes(30)),
            new TimeInterval(t0.AddMinutes(25), t0.AddMinutes(40))
        };

        var total = IntervalMerger.TotalDuration(intervals);

        Assert.Equal(TimeSpan.FromMinutes(40), total);
    }
}
