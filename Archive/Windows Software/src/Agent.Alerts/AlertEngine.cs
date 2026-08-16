using Agent.Core.Policy;
using Agent.Core.Time;
using Microsoft.Extensions.Logging;

namespace Agent.Alerts;

/// <summary>
/// Coordinates only - per the spec's "AlertEngine should only coordinate, no business logic
/// belongs here": load policy, find applicable rules, execute, dedup/escalate via
/// AlertStateManager, persist, notify. All actual rule logic lives in IAlertRule implementations.
/// </summary>
public sealed class AlertEngine<TEvent>(
    IEnumerable<IAlertRule<TEvent>> rules,
    IAlertRepository repository,
    IAlertNotifier notifier,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<AlertEngine<TEvent>> logger)
{
    public async Task ProcessAsync(TEvent telemetryEvent, string machineId, string userSid, CancellationToken cancellationToken)
    {
        if (!policyProvider.Current.Alert.Enabled)
        {
            return;
        }

        foreach (var rule in rules)
        {
            if (!rule.ShouldEvaluate(telemetryEvent))
            {
                continue;
            }

            try
            {
                var evaluation = await rule.EvaluateAsync(telemetryEvent, policyProvider.Current, cancellationToken).ConfigureAwait(false);
                if (evaluation is not null)
                {
                    await ApplyAsync(machineId, userSid, evaluation, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Alert rule {Rule} failed while evaluating an event.", rule.GetType().Name);
            }
        }
    }

    private async Task ApplyAsync(string machineId, string userSid, AlertEvaluationResult evaluation, CancellationToken cancellationToken)
    {
        var nowUtc = clock.UtcNow;
        var existing = await repository.FindOpenAlertAsync(machineId, userSid, evaluation.Type, cancellationToken).ConfigureAwait(false);
        var renotifyInterval = policyProvider.Current.Alert.Idle.RenotifyInterval;
        var decision = AlertStateManager.Decide(existing, evaluation, nowUtc, renotifyInterval);

        AlertRecord alert;

        if (decision.IsNewAlert)
        {
            alert = new AlertRecord
            {
                ClientEventId = Guid.NewGuid(),
                MachineId = machineId,
                UserSid = userSid,
                Type = evaluation.Type,
                Severity = evaluation.Severity,
                State = AlertState.New,
                Title = evaluation.Title,
                Message = evaluation.Message,
                ContextJson = evaluation.ContextJson,
                TriggeredAtUtc = nowUtc,
                EscalationLevel = 1,
                NotificationCount = 0
            };

            await repository.SaveNewAsync(alert, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            alert = existing!;
            if (decision.IsEscalation)
            {
                await repository.EscalateAsync(alert.ClientEventId, evaluation.Severity, evaluation.Message, nowUtc, cancellationToken).ConfigureAwait(false);
            }
        }

        if (decision.ShouldNotify)
        {
            var displayed = await notifier.NotifyAsync(alert, cancellationToken).ConfigureAwait(false);
            if (displayed)
            {
                await repository.RecordNotificationAsync(alert.ClientEventId, nowUtc, cancellationToken).ConfigureAwait(false);
            }
        }
    }
}
