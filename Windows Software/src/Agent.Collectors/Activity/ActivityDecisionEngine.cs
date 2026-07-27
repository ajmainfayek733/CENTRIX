using System.IO;
using Agent.Core.Policy;

namespace Agent.Collectors.Activity;

/// <summary>
/// Pure decision logic — no I/O — implementing the spec's "Activity Decision Rules" and priority
/// order: Offline and Sleeping and Locked are checked first and are unconditional (Locked is
/// "immediate, ignore idle timer"; Sleeping "pauses all timers"); only once none of those apply
/// do input/CPU/meeting signals decide Active vs Idle.
/// </summary>
public static class ActivityDecisionEngine
{
    public static ActivityEvaluation Evaluate(ActivitySignal signal, ActivityPolicy policy)
    {
        if (signal.IsOffline)
        {
            return new ActivityEvaluation(ActivityState.Offline, ActivityReason.None);
        }

        if (signal.IsSleeping)
        {
            return new ActivityEvaluation(ActivityState.Sleeping, ActivityReason.None);
        }

        if (signal.IsSessionLocked)
        {
            return new ActivityEvaluation(ActivityState.Locked, ActivityReason.None);
        }

        if (policy.MeetingDetectionEnabled && signal.ForegroundContinuousDuration >= policy.MeetingOrPresentationFlagAfter)
        {
            if (Matches(policy.MeetingProcessNames, signal.ForegroundExecutable))
            {
                return new ActivityEvaluation(ActivityState.Active, ActivityReason.Meeting);
            }

            if (Matches(policy.PresentationProcessNames, signal.ForegroundExecutable))
            {
                return new ActivityEvaluation(ActivityState.Active, ActivityReason.Presentation);
            }
        }

        var hasRecentInput = signal.IdleInputDuration < policy.IdleThreshold;
        var isCpuBusy = signal.CpuUsagePercent >= policy.CpuBusyThresholdPercent;

        if (hasRecentInput)
        {
            return new ActivityEvaluation(ActivityState.Active, ActivityReason.None);
        }

        if (isCpuBusy)
        {
            return new ActivityEvaluation(ActivityState.Active, ActivityReason.CpuBusy);
        }

        return new ActivityEvaluation(ActivityState.Idle, ActivityReason.NoInput);
    }

    private static bool Matches(IReadOnlyList<string> processNames, string? foregroundExecutable)
    {
        if (foregroundExecutable is null)
        {
            return false;
        }

        var fileName = Path.GetFileNameWithoutExtension(foregroundExecutable);
        return processNames.Any(name => string.Equals(name, fileName, StringComparison.OrdinalIgnoreCase));
    }
}
