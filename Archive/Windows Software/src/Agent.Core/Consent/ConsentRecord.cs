namespace Agent.Core.Consent;

public sealed record ConsentRecord(string UserSid, string MachineId, int PolicyVersion, DateTimeOffset AcknowledgedAtUtc);

public interface IConsentStore
{
    Task<ConsentRecord?> GetAsync(string userSid, CancellationToken cancellationToken);

    /// <summary>
    /// The highest-policy-version acknowledgement recorded by ANY Windows account on this
    /// machine, regardless of which user is currently logged in. This is what gates the
    /// install-lifetime "ask once" behavior: once any employee has acknowledged the current
    /// policy on this device, the notice does not resurface for other accounts on the same
    /// machine unless a later, higher policy version is published.
    /// </summary>
    Task<ConsentRecord?> GetLatestForMachineAsync(string machineId, CancellationToken cancellationToken);

    Task SaveAsync(ConsentRecord record, CancellationToken cancellationToken);
}
