using Agent.Alerts;

namespace Agent.Tests.Unit.Alerts;

public class AlertStateManagerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan RenotifyInterval = TimeSpan.FromMinutes(15);

    private static AlertRecord Existing(AlertSeverity severity, DateTimeOffset? lastNotified) => new()
    {
        ClientEventId = Guid.NewGuid(),
        MachineId = "machine-1",
        UserSid = "S-1-5-21-user",
        Type = AlertType.ExcessiveIdle,
        Severity = severity,
        State = AlertState.Shown,
        Title = "Idle Alert",
        Message = "message",
        ContextJson = "{}",
        TriggeredAtUtc = T0,
        LastNotifiedAtUtc = lastNotified,
        EscalationLevel = 1,
        NotificationCount = 1
    };

    private static AlertEvaluationResult Evaluation(AlertSeverity severity) =>
        new(AlertType.ExcessiveIdle, severity, "Idle Alert", "message", "{}");

    [Fact]
    public void NoExistingAlert_CreatesNewAndNotifies()
    {
        var decision = AlertStateManager.Decide(null, Evaluation(AlertSeverity.Warning), T0, RenotifyInterval);

        Assert.True(decision.IsNewAlert);
        Assert.True(decision.ShouldNotify);
        Assert.False(decision.IsEscalation);
    }

    [Fact]
    public void SameSeverityWithinRenotifyWindow_DoesNotRenotify()
    {
        var existing = Existing(AlertSeverity.Warning, lastNotified: T0);
        var decision = AlertStateManager.Decide(existing, Evaluation(AlertSeverity.Warning), T0.AddMinutes(5), RenotifyInterval);

        Assert.False(decision.IsNewAlert);
        Assert.False(decision.IsEscalation);
        Assert.False(decision.ShouldNotify);
    }

    [Fact]
    public void SameSeverityPastRenotifyWindow_RenotifiesWithoutEscalating()
    {
        var existing = Existing(AlertSeverity.Warning, lastNotified: T0);
        var decision = AlertStateManager.Decide(existing, Evaluation(AlertSeverity.Warning), T0.AddMinutes(16), RenotifyInterval);

        Assert.False(decision.IsEscalation);
        Assert.True(decision.ShouldNotify);
    }

    [Fact]
    public void HigherSeverity_IsAnEscalationAndAlwaysNotifiesRegardlessOfRenotifyWindow()
    {
        var existing = Existing(AlertSeverity.Warning, lastNotified: T0);
        var decision = AlertStateManager.Decide(existing, Evaluation(AlertSeverity.Critical), T0.AddSeconds(1), RenotifyInterval);

        Assert.True(decision.IsEscalation);
        Assert.True(decision.ShouldNotify);
    }

    [Fact]
    public void NeverNotifiedBefore_AlwaysDueForRenotify()
    {
        var existing = Existing(AlertSeverity.Warning, lastNotified: null);
        var decision = AlertStateManager.Decide(existing, Evaluation(AlertSeverity.Warning), T0, RenotifyInterval);

        Assert.True(decision.ShouldNotify);
    }
}
