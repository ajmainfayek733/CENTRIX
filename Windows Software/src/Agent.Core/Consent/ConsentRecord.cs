namespace Agent.Core.Consent;

public sealed record ConsentRecord(string UserSid, string MachineId, int PolicyVersion, DateTimeOffset AcknowledgedAtUtc);

public interface IConsentStore
{
    Task<ConsentRecord?> GetAsync(string userSid, CancellationToken cancellationToken);

    Task SaveAsync(ConsentRecord record, CancellationToken cancellationToken);
}
