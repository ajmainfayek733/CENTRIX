using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace Agent.Storage.Sqlite;

/// <summary>
/// Generates a random 256-bit database encryption key on first run and protects it at rest
/// with Windows DPAPI (LocalMachine scope, matching the agent's LocalSystem service identity)
/// rather than storing it in plaintext config. See Microsoft Learn:
/// ProtectedData.Protect (https://learn.microsoft.com/dotnet/api/system.security.cryptography.protecteddata.protect).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiDatabaseKeyProvider(string keyFilePath) : IDatabaseKeyProvider
{
    public string GetOrCreatePassword()
    {
        if (File.Exists(keyFilePath))
        {
            var protectedBytes = File.ReadAllBytes(keyFilePath);
            var unprotectedBytes = ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.LocalMachine);
            return Convert.ToBase64String(unprotectedBytes);
        }

        var keyBytes = RandomNumberGenerator.GetBytes(32);
        var protectedNewBytes = ProtectedData.Protect(keyBytes, optionalEntropy: null, DataProtectionScope.LocalMachine);

        var directory = Path.GetDirectoryName(keyFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllBytes(keyFilePath, protectedNewBytes);
        return Convert.ToBase64String(keyBytes);
    }
}
