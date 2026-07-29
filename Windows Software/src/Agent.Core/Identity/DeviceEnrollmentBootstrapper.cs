using Microsoft.Extensions.Logging;

namespace Agent.Core.Identity;

/// <summary>
/// Imports the one-time device API key an administrator issued at registration (Workforce
/// Dashboard &gt; Employees &gt; Register Device, spec §2.2) into the local DPAPI-protected
/// credential store, if it hasn't been imported already. The raw key is supplied via a
/// machine-scoped environment variable — set once by IT tooling (GPO/Intune/SCCM) as part of
/// deploying the Agent to a specific device — rather than a config file, so nothing sensitive
/// is left sitting in plaintext on disk after the store has captured it.
/// </summary>
public static class DeviceEnrollmentBootstrapper
{
    public const string ProvisioningEnvironmentVariable = "WORKFORCEAGENT_DEVICE_API_KEY";

    /// <returns>true if the device has (or now has) a stored credential; false if it is still unenrolled.</returns>
    public static async Task<bool> EnsureEnrolledAsync(
        IDeviceCredentialStore credentialStore,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        if (await credentialStore.HasCredentialAsync(cancellationToken).ConfigureAwait(false))
        {
            return true;
        }

        var provisioningKey =
            Environment.GetEnvironmentVariable(ProvisioningEnvironmentVariable, EnvironmentVariableTarget.Machine)
            ?? Environment.GetEnvironmentVariable(ProvisioningEnvironmentVariable);

        if (string.IsNullOrWhiteSpace(provisioningKey))
        {
            logger.LogWarning(
                "This device is not enrolled with the backend (no stored device credential, and no {EnvVar} " +
                "provisioning value found). An administrator must register the device from the dashboard and set " +
                "{EnvVar} to the issued API key, then restart the Agent. Until then, backend calls will fail with " +
                "401 Unauthorized.",
                ProvisioningEnvironmentVariable,
                ProvisioningEnvironmentVariable);
            return false;
        }

        await credentialStore.SaveApiKeyAsync(provisioningKey.Trim(), cancellationToken).ConfigureAwait(false);
        logger.LogInformation("Device enrolled successfully using the provisioning credential from {EnvVar}.", ProvisioningEnvironmentVariable);
        return true;
    }
}
