using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Agent.Core;
using Agent.Core.Configuration;
using Agent.Core.Contracts;
using Agent.Core.Policy;
using Agent.Service.Credentials;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Backend;

/// <summary>Raised when the server rejected the device credential outright.</summary>
public sealed class DeviceUnauthorizedException(string message) : Exception(message);

/// <summary>Raised when an admin has deactivated this device — a stop condition, not a retry condition.</summary>
public sealed class DeviceDeactivatedException(string message) : Exception(message);

/// <summary>
/// The agent's half of the backend API. Every call carries the device API key as a bearer
/// token except enrollment, which carries the org enrollment token instead.
///
/// The 401/403 distinction matters and is surfaced as two exception types: 401 means the
/// credential is wrong and the agent should re-enroll, 403 means an admin deliberately
/// deactivated the device and the agent must stop syncing rather than retry forever.
/// </summary>
public sealed class BackendClient(
    HttpClient http,
    AgentConfiguration configuration,
    DeviceCredentialStore credentials,
    ILogger<BackendClient> logger)
{
    private readonly HttpClient _http = http;
    private readonly AgentConfiguration _configuration = configuration;
    private readonly DeviceCredentialStore _credentials = credentials;
    private readonly ILogger<BackendClient> _logger = logger;

    /// <summary>
    /// Features.md "Device Auth". Trades the install-time enrollment token for a device API
    /// key and stores it. Safe to call again: a re-enrolling machine is issued a fresh key.
    /// </summary>
    public async Task<bool> EnrollAsync(CancellationToken ct)
    {
        var registration = DeviceIdentity.BuildRegistration();

        using var request = new HttpRequestMessage(HttpMethod.Post, "api/v1/device/enroll")
        {
            Content = JsonContent.Create(registration, options: AgentJson.Options)
        };
        request.Headers.Add("X-Enrollment-Token", _configuration.EnrollmentToken);

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.Forbidden)
        {
            throw new DeviceDeactivatedException($"Enrollment refused: {body}");
        }

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Enrollment failed with {Status}: {Body}", (int)response.StatusCode, body);
            return false;
        }

        var result = AgentJson.Deserialize<EnrollmentResponse>(body);
        if (result?.ApiKey is null)
        {
            _logger.LogError("Enrollment succeeded but returned no API key");
            return false;
        }

        _credentials.Save(result.ApiKey);
        _logger.LogInformation("Device enrolled as {DeviceId}", result.DeviceId);
        return true;
    }

    /// <summary>
    /// Features.md "Device Auth": the agent must pass this before it starts syncing. Doubles
    /// as a cheap way to learn the current policy version without pulling the whole document.
    /// </summary>
    public async Task<HeartbeatResponse?> HeartbeatAsync(CancellationToken ct)
    {
        using var request = Authorized(HttpMethod.Get, "api/v1/heartbeat");
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);

        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return null;

        return await response.Content
            .ReadFromJsonAsync<HeartbeatResponse>(AgentJson.Options, ct)
            .ConfigureAwait(false);
    }

    public async Task<AgentPolicy?> GetPolicyAsync(CancellationToken ct)
    {
        using var request = Authorized(HttpMethod.Get, "api/v1/policy");
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);

        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Policy fetch failed with {Status}", (int)response.StatusCode);
            return null;
        }

        return await response.Content
            .ReadFromJsonAsync<AgentPolicy>(AgentJson.Options, ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Pushes one channel's batch. Returns the ids the server acknowledged; only those are
    /// marked sent locally, which is what makes an interrupted sync safe to repeat.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> PushEventsAsync<T>(
        TelemetryChannel channel,
        IReadOnlyList<T> events,
        CancellationToken ct) where T : ITelemetryEvent
    {
        if (events.Count == 0) return [];

        using var request = Authorized(HttpMethod.Post, $"api/v1/events/{channel.ToWireName()}");
        request.Content = JsonContent.Create(new { events }, options: AgentJson.Options);

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            // A 400 means the server will reject this batch every time it is resent. Log it
            // loudly — it is a contract drift between the agent's DTOs and the server's Zod
            // schemas, not a transient failure — but do not acknowledge, so the retention
            // sweep eventually drops the rows rather than the sync worker spinning on them.
            if (response.StatusCode == HttpStatusCode.BadRequest)
            {
                _logger.LogError("Server rejected a {Channel} batch as invalid: {Body}", channel, body);
            }
            else
            {
                _logger.LogWarning("Push of {Count} {Channel} event(s) failed with {Status}",
                    events.Count, channel, (int)response.StatusCode);
            }
            return [];
        }

        var result = await response.Content
            .ReadFromJsonAsync<PushEventsResponse>(AgentJson.Options, ct)
            .ConfigureAwait(false);

        return result?.AcknowledgedEventIds ?? [];
    }

    /// <summary>Uploads one screenshot as multipart form data.</summary>
    public async Task<bool> UploadScreenshotAsync(
        Guid clientEventId,
        string? userSid,
        DateTimeOffset capturedAt,
        string filePath,
        int? width,
        int? height,
        CancellationToken ct)
    {
        if (!File.Exists(filePath))
        {
            _logger.LogWarning("Screenshot {Id} is queued but its file is gone: {Path}", clientEventId, filePath);
            // Treated as delivered: the bytes cannot be recovered, and leaving the row pending
            // would retry a file that will never exist.
            return true;
        }

        using var content = new MultipartFormDataContent
        {
            { new StringContent(clientEventId.ToString()), "clientEventId" },
            { new StringContent(capturedAt.ToString("o")), "capturedAtUtc" }
        };

        if (userSid is not null) content.Add(new StringContent(userSid), "userSid");
        if (width.HasValue) content.Add(new StringContent(width.Value.ToString()), "width");
        if (height.HasValue) content.Add(new StringContent(height.Value.ToString()), "height");

        await using var stream = File.OpenRead(filePath);
        var file = new StreamContent(stream);
        file.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
        content.Add(file, "screenshot", Path.GetFileName(filePath));

        using var request = Authorized(HttpMethod.Post, "api/v1/screenshots");
        request.Content = content;

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Screenshot upload failed with {Status}", (int)response.StatusCode);
            return false;
        }

        return true;
    }

    /// <summary>Records the employee's acknowledgement of the monitoring notice (spec section 3).</summary>
    public async Task<bool> PostConsentAsync(string userSid, int policyVersion, DateTimeOffset acknowledgedAt, CancellationToken ct)
    {
        using var request = Authorized(HttpMethod.Post, "api/v1/consent");
        request.Content = JsonContent.Create(
            new { userSid, policyVersion, acknowledgedAt },
            options: AgentJson.Options);

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);
        return response.IsSuccessStatusCode;
    }

    private HttpRequestMessage Authorized(HttpMethod method, string path)
    {
        var apiKey = _credentials.Load()
                     ?? throw new DeviceUnauthorizedException("No device API key is stored; the agent must enroll first");

        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        return request;
    }

    private static async Task ThrowIfCredentialRejectedAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new DeviceUnauthorizedException($"Device credential rejected: {body}");
        }

        if (response.StatusCode == HttpStatusCode.Forbidden)
        {
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new DeviceDeactivatedException($"Device deactivated by an administrator: {body}");
        }
    }

    /// <summary>Builds the base address, enforcing HTTPS unless explicitly overridden (spec section 9).</summary>
    public static Uri BuildBaseAddress(AgentConfiguration configuration, ILogger logger)
    {
        var uri = new Uri(configuration.ServerUrl.TrimEnd('/') + "/", UriKind.Absolute);

        if (uri.Scheme == Uri.UriSchemeHttps) return uri;

        if (!configuration.AllowInsecureHttp)
        {
            throw new InvalidOperationException(
                $"ServerUrl '{configuration.ServerUrl}' is not HTTPS. Spec section 9 requires TLS for all " +
                "agent traffic. Set AllowInsecureHttp only for a local test server.");
        }

        logger.LogWarning(
            "Agent is configured to talk to {Url} over plain HTTP. Telemetry is unencrypted in transit — " +
            "this must not be used outside a test environment.", uri);
        return uri;
    }

    /// <summary>Used only for building diagnostic text in the host UI.</summary>
    public string ServerDescription => _configuration.ServerUrl;

    private static string Redact(string value) =>
        value.Length <= 8 ? "********" : string.Concat(value.AsSpan(0, 4), "...", value.AsSpan(value.Length - 4));

    public override string ToString() =>
        new StringBuilder("BackendClient(")
            .Append(_configuration.ServerUrl)
            .Append(", token=")
            .Append(Redact(_configuration.EnrollmentToken))
            .Append(')')
            .ToString();
}
