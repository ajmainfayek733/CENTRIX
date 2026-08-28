namespace Agent.Collectors.Activity;

public sealed record ActivitySessionTransition(ActivityState ClosedState, ActivityReason ClosedReason, DateTimeOffset StartUtc, DateTimeOffset EndUtc);

/// <summary>
/// Stores only state transitions, never per-tick snapshots, per the spec's "Rather than storing
/// every second, store transitions" guidance.
/// </summary>
public sealed class ActivitySessionTracker
{
    private (ActivityEvaluation Evaluation, DateTimeOffset StartUtc)? _current;

    public (ActivityEvaluation Evaluation, DateTimeOffset StartUtc)? Current => _current;

    public ActivitySessionTransition? Observe(ActivityEvaluation evaluation, DateTimeOffset atUtc)
    {
        if (_current is not { } current)
        {
            _current = (evaluation, atUtc);
            return null;
        }

        if (current.Evaluation == evaluation)
        {
            return null;
        }

        var transition = new ActivitySessionTransition(current.Evaluation.State, current.Evaluation.Reason, current.StartUtc, atUtc);
        _current = (evaluation, atUtc);
        return transition;
    }

    public ActivitySessionTransition? Close(DateTimeOffset atUtc)
    {
        if (_current is not { } current)
        {
            return null;
        }

        _current = null;
        return new ActivitySessionTransition(current.Evaluation.State, current.Evaluation.Reason, current.StartUtc, atUtc);
    }
}
