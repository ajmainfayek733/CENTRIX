using Agent.Collectors.Activity;
using Agent.Core.Policy;

namespace Agent.Tests.Unit.Activity;

public class ActivityDecisionEngineTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);
    private static readonly ActivityPolicy Policy = new();

    private static ActivitySignal Signal(
        TimeSpan idle,
        bool locked = false,
        bool sleeping = false,
        bool offline = false,
        string? foreground = null,
        TimeSpan foregroundDuration = default,
        double? cpu = null) => new()
    {
        AtUtc = T0,
        IdleInputDuration = idle,
        IsSessionLocked = locked,
        IsSleeping = sleeping,
        IsOffline = offline,
        ForegroundExecutable = foreground,
        ForegroundContinuousDuration = foregroundDuration,
        CpuUsagePercent = cpu
    };

    [Fact]
    public void RecentInput_IsActive()
    {
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.FromSeconds(10)), Policy);
        Assert.Equal(ActivityState.Active, result.State);
    }

    [Fact]
    public void NoInputPastThreshold_IsIdle()
    {
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.FromMinutes(6)), Policy);
        Assert.Equal(ActivityState.Idle, result.State);
        Assert.Equal(ActivityReason.NoInput, result.Reason);
    }

    [Fact]
    public void JigglingMouseJustUnderThreshold_RemainsActive()
    {
        // Edge case 1: user jiggles mouse every 4m59s — should remain Active.
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.FromSeconds(4 * 60 + 59)), Policy);
        Assert.Equal(ActivityState.Active, result.State);
    }

    [Fact]
    public void LockedSession_IsAlwaysLockedNeverIdle_RegardlessOfIdleDuration()
    {
        // Edge case: "Locked PC. Never Idle, Always Locked." Immediate, ignores idle timer.
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.FromSeconds(1), locked: true), Policy);
        Assert.Equal(ActivityState.Locked, result.State);
    }

    [Fact]
    public void Sleeping_TakesPriorityOverEverythingElse()
    {
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.Zero, sleeping: true, locked: true), Policy);
        Assert.Equal(ActivityState.Sleeping, result.State);
    }

    [Fact]
    public void Offline_TakesTopPriority()
    {
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.Zero, offline: true, sleeping: true, locked: true), Policy);
        Assert.Equal(ActivityState.Offline, result.State);
    }

    [Fact]
    public void HighCpuWithNoInput_RemainsActive()
    {
        // Edge case 6: long compilation/rendering — 0 mouse movement, CPU 95%, remain Active.
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.FromMinutes(10), cpu: 95.0), Policy);
        Assert.Equal(ActivityState.Active, result.State);
        Assert.Equal(ActivityReason.CpuBusy, result.Reason);
    }

    [Fact]
    public void LargeDownloadWithZeroCpuAndNoInput_RemainsIdle()
    {
        // Edge case 7: large download, no input, CPU 0% — should remain Idle.
        var result = ActivityDecisionEngine.Evaluate(Signal(TimeSpan.FromMinutes(10), cpu: 0.0), Policy);
        Assert.Equal(ActivityState.Idle, result.State);
    }

    [Fact]
    public void MeetingAppFocusedPast40Minutes_OverridesIdleToActiveWithMeetingReason()
    {
        var result = ActivityDecisionEngine.Evaluate(
            Signal(TimeSpan.FromMinutes(10), foreground: @"C:\Teams.exe", foregroundDuration: TimeSpan.FromMinutes(41)),
            Policy);

        Assert.Equal(ActivityState.Active, result.State);
        Assert.Equal(ActivityReason.Meeting, result.Reason);
    }

    [Fact]
    public void MeetingAppFocusedUnder40Minutes_DoesNotOverrideIdle()
    {
        var result = ActivityDecisionEngine.Evaluate(
            Signal(TimeSpan.FromMinutes(10), foreground: @"C:\Teams.exe", foregroundDuration: TimeSpan.FromMinutes(20)),
            Policy);

        Assert.Equal(ActivityState.Idle, result.State);
    }

    [Fact]
    public void PresentationAppFocusedPast40Minutes_OverridesIdleWithPresentationReason()
    {
        var result = ActivityDecisionEngine.Evaluate(
            Signal(TimeSpan.FromMinutes(45), foreground: @"C:\Program Files\Office\POWERPNT.EXE", foregroundDuration: TimeSpan.FromMinutes(45)),
            Policy);

        Assert.Equal(ActivityState.Active, result.State);
        Assert.Equal(ActivityReason.Presentation, result.Reason);
    }

    [Fact]
    public void NonMeetingAppFocusedPast40Minutes_DoesNotTriggerMeetingOverride()
    {
        var result = ActivityDecisionEngine.Evaluate(
            Signal(TimeSpan.FromMinutes(10), foreground: @"C:\notepad.exe", foregroundDuration: TimeSpan.FromMinutes(50)),
            Policy);

        Assert.Equal(ActivityState.Idle, result.State);
    }

    [Fact]
    public void MeetingDetectionDisabled_NeverOverridesIdle()
    {
        var policy = new ActivityPolicy { MeetingDetectionEnabled = false };
        var result = ActivityDecisionEngine.Evaluate(
            Signal(TimeSpan.FromMinutes(10), foreground: @"C:\Teams.exe", foregroundDuration: TimeSpan.FromMinutes(60)),
            policy);

        Assert.Equal(ActivityState.Idle, result.State);
    }
}
