namespace Agent.Core.Identity;

/// <summary>
/// Holds the device API key issued once by the backend at enrollment (spec §2.2) and sent as
/// `Authorization: Bearer &lt;key&gt;` on every backend call thereafter. Never holds the value in
/// plaintext at rest — see Agent.Storage's DPAPI-backed implementation.
/// </summary>
public interface IDeviceCredentialStore
{
    Task<bool> HasCredentialAsync(CancellationToken cancellationToken);

    Task<string?> GetApiKeyAsync(CancellationToken cancellationToken);

    Task SaveApiKeyAsync(string rawApiKey, CancellationToken cancellationToken);
}
