namespace Agent.Core.Policy;

/// <summary>
/// Synced data is deleted locally immediately on backend acknowledgement. This governs only
/// the fallback: data that has never been successfully synced.
/// </summary>
public sealed record RetentionPolicy
{
    public int UndeliveredRetentionDays { get; init; } = 30;
}
