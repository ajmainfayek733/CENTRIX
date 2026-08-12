using Agent.Alerts;
using Agent.Alerts.Rules;
using Agent.Core.Policy;

namespace Agent.Tests.Unit.Alerts;

public class IdleAlertRuleTests
{
    private static readonly IdleAlertPolicy Policy = new();

    [Fact]
    public void BelowWarningThreshold_NoAlert()
    {
        var result = IdleAlertRule.Evaluate(TimeSpan.FromMinutes(30), Policy);
        Assert.Null(result);
    }

    [Fact]
    public void AtWarningThreshold_WarningSeverity()
    {
        var result = IdleAlertRule.Evaluate(TimeSpan.FromMinutes(60), Policy);
        Assert.Equal(AlertSeverity.Warning, result!.Severity);
    }

    [Fact]
    public void AtHighThreshold_HighSeverity()
    {
        var result = IdleAlertRule.Evaluate(TimeSpan.FromMinutes(70), Policy);
        Assert.Equal(AlertSeverity.High, result!.Severity);
    }

    [Fact]
    public void AtCriticalThreshold_CriticalSeverity()
    {
        var result = IdleAlertRule.Evaluate(TimeSpan.FromMinutes(80), Policy);
        Assert.Equal(AlertSeverity.Critical, result!.Severity);
    }

    [Fact]
    public void AtNotifyManagerThreshold_StillCriticalSeverityWithEscalatedMessage()
    {
        var result = IdleAlertRule.Evaluate(TimeSpan.FromMinutes(90), Policy);
        Assert.Equal(AlertSeverity.Critical, result!.Severity);
        Assert.Contains("manager", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void JustBelowEachThreshold_DoesNotYetEscalate()
    {
        var result = IdleAlertRule.Evaluate(TimeSpan.FromMinutes(69), Policy);
        Assert.Equal(AlertSeverity.Warning, result!.Severity);
    }
}
