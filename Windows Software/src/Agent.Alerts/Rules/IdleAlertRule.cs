using System.Text.Json;
using Agent.Collectors.Activity;
using Agent.Core.Policy;

namespace Agent.Alerts.Rules;

/// <summary>
/// Not fired by a single point-in-time event - <see cref="IdleAlertPeriodicChecker"/> feeds this
/// rule a repeated snapshot of the currently-open Idle session (with EndTimeUtc set to "now" for
/// that check), so the same escalation/dedup machinery in AlertEngine works uniformly for both
/// event-driven and time-driven rules.
/// </summary>
public sealed class IdleAlertRule : IAlertRule<ActivitySessionRecord>
{
    public bool ShouldEvaluate(ActivitySessionRecord telemetryEvent) =>
        telemetryEvent.State == ActivityState.Idle && telemetryEvent.EndTimeUtc is not null;

    public Task<AlertEvaluationResult?> EvaluateAsync(ActivitySessionRecord telemetryEvent, PolicyDocument policy, CancellationToken cancellationToken)
    {
        var idlePolicy = policy.Alert.Idle;
        if (!policy.Alert.Enabled || !idlePolicy.Enabled)
        {
            return Task.FromResult<AlertEvaluationResult?>(null);
        }

        var elapsed = telemetryEvent.EndTimeUtc!.Value - telemetryEvent.StartTimeUtc;
        return Task.FromResult(Evaluate(elapsed, idlePolicy));
    }

    public static AlertEvaluationResult? Evaluate(TimeSpan idleElapsed, IdleAlertPolicy policy)
    {
        AlertSeverity severity;
        string message;

        if (idleElapsed >= policy.CriticalAfter)
        {
            severity = AlertSeverity.Critical;
            message = idleElapsed >= policy.NotifyManagerAfter
                ? "Employee idle past the manager-notification threshold."
                : "Employee has been idle past the critical threshold.";
        }
        else if (idleElapsed >= policy.HighAfter)
        {
            severity = AlertSeverity.High;
            message = "Employee has been idle past the high threshold.";
        }
        else if (idleElapsed >= policy.WarningAfter)
        {
            severity = AlertSeverity.Warning;
            message = "Employee has been idle past the warning threshold.";
        }
        else
        {
            return null;
        }

        var context = JsonSerializer.Serialize(new
        {
            IdleSeconds = (int)idleElapsed.TotalSeconds,
            ThresholdSeconds = (int)policy.WarningAfter.TotalSeconds
        });

        return new AlertEvaluationResult(AlertType.ExcessiveIdle, severity, "Idle Alert", message, context);
    }
}
