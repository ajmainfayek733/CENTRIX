using System.Security.Cryptography;
using System.Text;
using Agent.Core;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Credentials;

/// <summary>
/// Stores the per-device API key issued at enrollment.
///
/// Protected with DPAPI at <see cref="DataProtectionScope.LocalMachine"/> scope: the service runs
/// as SYSTEM and must read the key at boot, before any user has logged on, so CurrentUser scope
/// would not work.
///
/// BE CLEAR ABOUT WHAT THIS DOES AND DOES NOT BUY. LocalMachine binds the ciphertext to this
/// machine, so the file is worthless copied to another workstation. It does *not* restrict
/// decryption to privileged callers: Microsoft's wording is that with LocalMachine "any process
/// running on the computer can unprotect data", and the caution is to use it "only when you trust
/// every account on a computer". The entropy below is compiled into an executable that ships to
/// every workstation, so it is obfuscation, not a secret.
///
/// The control that actually keeps a standard user away from this key is therefore the **ACL on
/// the containing directory** - SYSTEM and Administrators only, applied by the install-time
/// configure step. If that ACL is ever weakened, this file is readable by anyone who can run code
/// on the box, DPAPI or not.
/// </summary>
public sealed class DeviceCredentialStore(ILogger<DeviceCredentialStore> logger)
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("EmployeeMonitor.Agent.DeviceApiKey.v3");

    private readonly ILogger<DeviceCredentialStore> _logger = logger;

    public bool HasCredential => File.Exists(AgentPaths.CredentialPath);

    public void Save(string apiKey)
    {
        AgentPaths.EnsureCreated();

        var plaintext = Encoding.UTF8.GetBytes(apiKey);

        try
        {
            var ciphertext = ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.LocalMachine);
            File.WriteAllBytes(AgentPaths.CredentialPath, ciphertext);
        }
        finally
        {
            // The key in the clear does not stay in the heap waiting to be swapped to disk or
            // scooped out of a crash dump. It cannot be scrubbed from the caller's string - those
            // are immutable - but this copy is ours to erase.
            CryptographicOperations.ZeroMemory(plaintext);
        }

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

            try
            {
                return Encoding.UTF8.GetString(plaintext);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
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
