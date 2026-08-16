namespace Agent.Collectors.Attendance;

public readonly record struct AttendanceValidationResult(bool IsValid, string? RejectionReason)
{
    public static AttendanceValidationResult Accept() => new(true, null);

    public static AttendanceValidationResult Reject(string reason) => new(false, reason);
}

public static class AttendanceValidator
{
    private static readonly TimeSpan ClockSkewTolerance = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Rejects corrupted or malicious input before it ever reaches the state machine: future
    /// timestamps (clock tampering / corrupted DB) per the Attendance spec's explicit
    /// "future timestamps" and "negative duration" edge cases.
    /// </summary>
    public static AttendanceValidationResult Validate(AttendanceRawEvent candidate, DateTimeOffset nowUtc)
    {
        if (candidate.OccurredAtUtc > nowUtc + ClockSkewTolerance)
        {
            return AttendanceValidationResult.Reject("Event timestamp is in the future.");
        }

        return AttendanceValidationResult.Accept();
    }
}
