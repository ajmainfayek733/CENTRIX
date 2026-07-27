namespace Agent.Collectors.Activity;

/// <summary>Exactly the five states from the spec's "Enterprise State Machine" — never skip states.</summary>
public enum ActivityState
{
    Active,
    Idle,
    Locked,
    Sleeping,
    Offline
}

public enum ActivityReason
{
    None,
    NoInput,
    Meeting,
    Presentation,
    CpuBusy,
    SuspiciousActivity,
    PossibleAutomation
}

public sealed record ActivityEvaluation(ActivityState State, ActivityReason Reason);
