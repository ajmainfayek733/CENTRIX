using System.Net;
using System.Net.Http.Headers;
using Agent.Core.Identity;
using Microsoft.Extensions.Logging;

namespace Agent.Sync;

/// <summary>
/// Attaches the device's bearer credential (spec §2.2) to every outgoing backend request, and
/// logs a clear, actionable message when the backend rejects it — this is the piece that was
/// entirely missing before: HttpBackendClient's own doc comment used to say authentication was
/// "expected to be configured on the injected HttpClient ... by the composition root", but no
/// composition root ever did it, so every call went out with no Authorization header at all and
/// the backend correctly rejected it with 401.
/// </summary>
public sealed class DeviceAuthDelegatingHandler(
    IDeviceCredentialStore credentialStore,
    ILogger<DeviceAuthDelegatingHandler> logger) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var apiKey = await credentialStore.GetApiKeyAsync(cancellationToken).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(apiKey))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        }

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            logger.LogError(
                "Backend rejected this device's credential (401) on {Method} {Uri}. Either this device has never " +
                "been enrolled (set {EnvVar} and restart), or its API key was rotated/revoked by an administrator " +
                "and it must be re-enrolled.",
                request.Method,
                request.RequestUri,
                DeviceEnrollmentBootstrapper.ProvisioningEnvironmentVariable);
        }
        else if (response.StatusCode == HttpStatusCode.Forbidden)
        {
            logger.LogError(
                "Backend reports this device has been deactivated (403) on {Method} {Uri}. An administrator must " +
                "reactivate it from the dashboard before sync will resume.",
                request.Method,
                request.RequestUri);
        }

        return response;
    }
}
