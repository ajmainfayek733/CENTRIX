using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Agent.Core.Identity;

namespace Agent.Storage.Security;

/// <summary>
/// Protects the device API key at rest with Windows DPAPI (LocalMachine scope, matching the
/// agent's LocalSystem service identity), the same pattern used for the SQLite database key -
/// see Agent.Storage.Sqlite.DpapiDatabaseKeyProvider. Reads are cached in memory after the first
/// hit since the file only ever changes via SaveApiKeyAsync from this same process tree.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiDeviceCredentialStore(string keyFilePath) : IDeviceCredentialStore
{
    private readonly Lock _gate = new();
    private string? _cachedApiKey;
    private bool _cacheLoaded;

    public Task<bool> HasCredentialAsync(CancellationToken cancellationToken) =>
        Task.FromResult(TryReadCached() is not null);

    public Task<string?> GetApiKeyAsync(CancellationToken cancellationToken) =>
        Task.FromResult(TryReadCached());

    public Task SaveApiKeyAsync(string rawApiKey, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rawApiKey);

        var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(rawApiKey), optionalEntropy: null, DataProtectionScope.LocalMachine);

        var directory = Path.GetDirectoryName(keyFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllBytes(keyFilePath, protectedBytes);

        lock (_gate)
        {
            _cachedApiKey = rawApiKey;
            _cacheLoaded = true;
        }

        return Task.CompletedTask;
    }

    private string? TryReadCached()
    {
        lock (_gate)
        {
            if (_cacheLoaded)
            {
                return _cachedApiKey;
            }

            _cachedApiKey = ReadFromDisk();
            _cacheLoaded = true;
            return _cachedApiKey;
        }
    }

    private string? ReadFromDisk()
    {
        if (!File.Exists(keyFilePath))
        {
            return null;
        }

        var protectedBytes = File.ReadAllBytes(keyFilePath);
        var unprotectedBytes = ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.LocalMachine);
        return Encoding.UTF8.GetString(unprotectedBytes);
    }
}
