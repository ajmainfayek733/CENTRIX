using System.Security.Cryptography;
using System.Text;
using Agent.Core;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Credentials;

/// <summary>
/// Stores the per-device API key issued at enrollment.
///
/// Protected with DPAPI at <see cref="DataProtectionScope.LocalMachine"/> scope: the service
/// runs as SYSTEM and must be able to read the key at boot, before any user has logged on, so
/// CurrentUser scope would not work. LocalMachine scope means the ciphertext is bound to this
/// machine — copying the file to another workstation yields nothing — but any process that can
/// already run as Administrator on this box could unprotect it, which is why the containing
/// directory is ACL'd to SYSTEM and Administrators.
/// </summary>
public sealed class DeviceCredentialStore(ILogger<DeviceCredentialStore> logger)
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("EmployeeMonitor.Agent.DeviceApiKey.v3");

    private readonly ILogger<DeviceCredentialStore> _logger = logger;

    public bool HasCredential => File.Exists(AgentPaths.CredentialPath);

    public void Save(string apiKey)
    {
        AgentPaths.EnsureCreated();

        var ciphertext = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(apiKey),
            Entropy,
            DataProtectionScope.LocalMachine);

        File.WriteAllBytes(AgentPaths.CredentialPath, ciphertext);
        _logger.LogInformation("Device API key stored at {Path}", AgentPaths.CredentialPath);
    }

    /// <summary>
    /// Returns the stored key, or null if there is none or it cannot be decrypted. An
    /// undecryptable key is deleted rather than retried forever: it means the file was copied
    /// from another machine or the machine was re-imaged, and the fix in both cases is to
    /// re-enroll.
    /// </summary>
    public string? Load()
    {
        if (!HasCredential) return null;

        try
        {
            var ciphertext = File.ReadAllBytes(AgentPaths.CredentialPath);
            var plaintext = ProtectedData.Unprotect(ciphertext, Entropy, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(plaintext);
        }
        catch (CryptographicException ex)
        {
            _logger.LogError(ex,
                "Stored device API key could not be decrypted on this machine; deleting it and re-enrolling");
            Clear();
            return null;
        }
    }

    public void Clear()
    {
        try
        {
            if (File.Exists(AgentPaths.CredentialPath)) File.Delete(AgentPaths.CredentialPath);
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Could not delete the stored device API key");
        }
    }
}
