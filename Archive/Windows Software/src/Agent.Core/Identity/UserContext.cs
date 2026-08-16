namespace Agent.Core.Identity;

public sealed record UserContext(string UserSid, string? EmployeeId, int SessionId, bool IsRemoteSession);
