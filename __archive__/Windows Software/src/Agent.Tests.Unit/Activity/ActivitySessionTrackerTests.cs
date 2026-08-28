using Agent.Collectors.Activity;

namespace Agent.Tests.Unit.Activity;

public class ActivitySessionTrackerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void SameEvaluationRepeated_IsNoOp()
    {
        var tracker = new ActivitySessionTracker();
        var active = new ActivityEvaluation(ActivityState.Active, ActivityReason.None);

        tracker.Observe(active, T0);
        var transition = tracker.Observe(active, T0.AddMinutes(1));

        Assert.Null(transition);
    }

    [Fact]
    public void StateChange_ClosesPreviousAndOpensNew()
    {
        var tracker = new ActivitySessionTracker();
        tracker.Observe(new ActivityEvaluation(ActivityState.Active, ActivityReason.None), T0);

        var transition = tracker.Observe(new ActivityEvaluation(ActivityState.Idle, ActivityReason.NoInput), T0.AddMinutes(5));

        Assert.Equal(ActivityState.Active, transition!.ClosedState);
        Assert.Equal(ActivityState.Idle, tracker.Current!.Value.Evaluation.State);
    }

    [Fact]
    public void SameStateDifferentReason_IsTreatedAsATransition()
    {
        // Active/None -> Active/Meeting should still record a boundary, since the reason
        // (Meeting classification) is analytically meaningful even though State is unchanged.
        var tracker = new ActivitySessionTracker();
        tracker.Observe(new ActivityEvaluation(ActivityState.Active, ActivityReason.None), T0);

        var transition = tracker.Observe(new ActivityEvaluation(ActivityState.Active, ActivityReason.Meeting), T0.AddMinutes(40));

        Assert.NotNull(transition);
        Assert.Equal(ActivityReason.None, transition!.ClosedReason);
    }
}
