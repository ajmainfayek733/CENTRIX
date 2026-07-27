namespace Agent.Alerts;

public sealed record AlertDecision(bool IsNewAlert, bool IsEscalation, bool ShouldNotify);

/// <summary>
/// Pure dedup/escalation/throttle logic — no I/O — implementing the spec's "one alert,
/// escalated" model instead of a new row per poll tick, plus renotify throttling so an
/// unresolved alert doesn't spam a notification on every evaluation.
/// </summary>
public static class AlertStateManager
{
    public static AlertDecision Decide(
        AlertRecord? existingOpenAlert,
        AlertEvaluationResult newEvaluation,
        DateTimeOffset nowUtc,
        TimeSpan renotifyInterval)
    {
        if (existingOpenAlert is null)
        {
            return new AlertDecision(IsNewAlert: true, IsEscalation: false, ShouldNotify: true);
        }

        var isEscalation = newEvaluation.Severity > existingOpenAlert.Severity;
        var dueForRenotify = existingOpenAlert.LastNotifiedAtUtc is not { } lastNotified
            || nowUtc - lastNotified >= renotifyInterval;

        return new AlertDecision(IsNewAlert: false, IsEscalation: isEscalation, ShouldNotify: isEscalation || dueForRenotify);
    }
}
