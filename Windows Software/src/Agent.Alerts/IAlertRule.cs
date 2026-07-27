using Agent.Core.Policy;

namespace Agent.Alerts;

/// <summary>
/// One rule per alert type, per the spec's recommended Rules Engine + Strategy pattern —
/// adding a new alert type never requires modifying the engine itself.
/// </summary>
public interface IAlertRule<in TEvent>
{
    bool ShouldEvaluate(TEvent telemetryEvent);

    Task<AlertEvaluationResult?> EvaluateAsync(TEvent telemetryEvent, PolicyDocument policy, CancellationToken cancellationToken);
}
