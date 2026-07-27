namespace Agent.Core.Policy;

public sealed record UsbPolicy
{
    public bool Enabled { get; init; } = true;

    public TimeSpan ReconciliationInterval { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan EventCorrelationWindow { get; init; } = TimeSpan.FromSeconds(3);

    /// <summary>Disabled by default, matching the blacklist's admin-opt-in pattern — most
    /// organizations don't want every USB insertion raising an alert.</summary>
    public bool AlertOnInsertion { get; init; }
}
