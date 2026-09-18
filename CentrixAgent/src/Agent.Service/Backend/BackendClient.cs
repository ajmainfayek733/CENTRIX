using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
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

/// <summary>Raised when an admin has deactivated this device - a stop condition, not a retry condition.</summary>
public sealed class DeviceDeactivatedException(string message) : Exception(message);

/// <summary>
/// Outcome of pushing one channel's events.
///
/// The three-way split exists because the queue must treat the cases differently. Acknowledged
/// events are marked sent. Rejected events are ones the server will refuse identically on every
/// retry, so their attempt counter advances toward being dropped. A transient failure must
/// advance nothing - otherwise a week-long network outage would age out perfectly good data.
/// </summary>
/// <param name="Acknowledged">Ids the server explicitly confirmed it stored.</param>
/// <param name="Rejected">Ids the server refused for a reason retrying cannot fix.</param>
/// <param name="TransientFailure">True when the network or server failed in a way worth retrying.</param>
public sealed record PushResult(
    IReadOnlyList<Guid> Acknowledged,
    IReadOnlyList<Guid> Rejected,
    bool TransientFailure)
{
    public static PushResult Nothing { get; } = new([], [], false);
}

/// <summary>Single-item equivalent of <see cref="PushResult"/>, used for screenshot uploads.</summary>
public enum UploadOutcome
{
    /// <summary>Stored by the server, or unrecoverable locally. Either way, stop retrying.</summary>
    Delivered,

    /// <summary>Refused for a reason resending cannot fix.</summary>
    Rejected,

    /// <summary>Network or server failure. Worth retrying unchanged.</summary>
    Transient
}

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
    /// Byte ceiling for one events request, measured on the encoded JSON.
    ///
    /// The server enforces its own limit (JSON_BODY_LIMIT, 2 MB by default) and answers 413 when
    /// a body exceeds it. Capping here instead means the agent never builds a request it knows
    /// will be refused: a full 500-event batch of activity sessions carrying window titles and
    /// executable paths comfortably exceeded Express's old 100 KB default, which is exactly the
    /// 413 this budget prevents.
    ///
    /// Deliberately well under the server's ceiling. The gap absorbs the difference between this
    /// estimate and the exact encoded size, and leaves room for the server limit to be lowered
    /// without immediately breaking uploads.
    /// </summary>
    private const int MaxRequestBytes = 900_000;

    /// <summary>Allowance for the `{"events":[ ]}` envelope when packing a request.</summary>
    private const int EnvelopeOverheadBytes = 64;

    /// <summary>
    /// Pushes one channel's batch, split into as many requests as the byte budget requires.
    ///
    /// Only ids the server explicitly acknowledged are reported back as acknowledged, which is
    /// what makes an interrupted sync safe to repeat: anything unconfirmed stays queued and is
    /// resent verbatim, and the server deduplicates on the client event id.
    ///
    /// Chunks are sent sequentially, never in parallel. Thirty workstations draining a backlog at
    /// once is already a burst; letting each one open several concurrent uploads would turn a
    /// recovering server into an overloaded one.
    /// </summary>
    public async Task<PushResult> PushEventsAsync<T>(
        TelemetryChannel channel,
        IReadOnlyList<T> events,
        CancellationToken ct) where T : ITelemetryEvent
    {
        if (events.Count == 0) return PushResult.Nothing;

        var acknowledged = new List<Guid>();
        var rejected = new List<Guid>();

        foreach (var chunk in PackIntoRequests(channel, events, rejected))
        {
            var result = await PushChunkAsync(channel, chunk, ct).ConfigureAwait(false);

            acknowledged.AddRange(result.Acknowledged);
            rejected.AddRange(result.Rejected);

            // A transient failure will almost certainly hit the following chunks too, so stop
            // rather than multiplying timeouts. What was not sent stays queued.
            //
            // A *rejection* does not stop the loop: one malformed chunk must not block every
            // healthy event queued behind it.
            if (result.TransientFailure)
            {
                return new PushResult(acknowledged, rejected, TransientFailure: true);
            }
        }

        return new PushResult(acknowledged, rejected, TransientFailure: false);
    }

    /// <summary>
    /// Greedily packs events into requests that fit the byte budget.
    ///
    /// An event so large it cannot fit on its own is hopeless - no amount of splitting makes it
    /// sendable - so it is reported as rejected here rather than wasting a round trip to be told
    /// the same thing.
    /// </summary>
    private List<List<T>> PackIntoRequests<T>(
        TelemetryChannel channel,
        IReadOnlyList<T> events,
        List<Guid> rejected) where T : ITelemetryEvent
    {
        var budget = MaxRequestBytes - EnvelopeOverheadBytes;
        var requests = new List<List<T>>();
        var current = new List<T>();
        var currentBytes = 0;

        foreach (var telemetryEvent in events)
        {
            // +1 for the separating comma.
            var size = Encoding.UTF8.GetByteCount(AgentJson.Serialize(telemetryEvent)) + 1;

            if (size > budget)
            {
                _logger.LogError(
                    "Dropping a {Channel} event: it encodes to {Size} bytes, which no request can carry " +
                    "(budget {Budget}). Event id {Id}",
                    channel, size, budget, telemetryEvent.ClientEventId);

                rejected.Add(telemetryEvent.ClientEventId);
                continue;
            }

            if (currentBytes + size > budget && current.Count > 0)
            {
                requests.Add(current);
                current = [];
                currentBytes = 0;
            }

            current.Add(telemetryEvent);
            currentBytes += size;
        }

        if (current.Count > 0) requests.Add(current);
        return requests;
    }

    /// <summary>
    /// Sends one request's worth of events.
    ///
    /// A 413 here means the packing estimate and the server's limit disagree - the server may
    /// have been reconfigured downward. Rather than failing, the chunk is halved and retried,
    /// which converges on something that fits. Only a single event that still will not fit is
    /// treated as unsendable.
    /// </summary>
    private async Task<PushResult> PushChunkAsync<T>(
        TelemetryChannel channel,
        List<T> events,
        CancellationToken ct) where T : ITelemetryEvent
    {
        using var request = Authorized(HttpMethod.Post, $"api/v1/events/{channel.ToWireName()}");
        request.Content = JsonContent.Create(
            new { batchId = DeterministicBatchId(events), events },
            options: AgentJson.Options);

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);

        if (response.IsSuccessStatusCode)
        {
            var result = await response.Content
                .ReadFromJsonAsync<PushEventsResponse>(AgentJson.Options, ct)
                .ConfigureAwait(false);

            return new PushResult(result?.AcknowledgedEventIds ?? [], [], TransientFailure: false);
        }

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.RequestEntityTooLarge)
        {
            if (events.Count == 1)
            {
                _logger.LogError(
                    "Server refused a single {Channel} event as too large: {Body}", channel, body);
                return new PushResult([], [events[0].ClientEventId], TransientFailure: false);
            }

            _logger.LogWarning(
                "Server refused a {Count}-event {Channel} request as too large; halving and retrying. {Body}",
                events.Count, channel, body);

            return await PushHalvesAsync(channel, events, ct).ConfigureAwait(false);
        }

        // A 4xx means the server will refuse this data identically every time it is resent -
        // contract drift between the agent's DTOs and the server's Zod schemas, not a blip. Log
        // it loudly and let the attempt counter carry these rows toward being dropped, rather
        // than resending them every cycle until the retention window expires.
        if ((int)response.StatusCode is >= 400 and < 500)
        {
            _logger.LogError("Server rejected {Count} {Channel} event(s) as invalid: {Body}",
                events.Count, channel, body);

            return new PushResult([], events.Select(e => e.ClientEventId).ToList(), TransientFailure: false);
        }

        _logger.LogWarning("Push of {Count} {Channel} event(s) failed with {Status}: {Body}",
            events.Count, channel, (int)response.StatusCode, body);

        return new PushResult([], [], TransientFailure: true);
    }

    /// <summary>
    /// A batch identifier derived from the batch's own contents, so a resend is recognizable.
    ///
    /// Deliberately NOT a fresh Guid per attempt. The case this exists for is the one where the
    /// server committed the batch and the response was lost on the way back: the queue still
    /// holds those events as unacknowledged and sends them again. A random id would look like a
    /// brand new batch and the server would redo the whole validate-categorize-aggregate pass to
    /// reach the same conclusion - at exactly the moment a fleet is replaying a backlog and can
    /// least afford it.
    ///
    /// Hashing the sorted serialized events means the same snapshot is always recognized on retry,
    /// whichever order the queue handed it over. This must include the payload, not only the event
    /// ids: attendance reuses its client event id while its revision and totals change over time.
    /// If only ids were hashed, a newer attendance snapshot would be incorrectly treated as a
    /// replay and would never reach the server's revision-aware upsert.
    ///
    /// The digest is shaped into an RFC 4122 version-5 UUID because the server validates the
    /// field as a uuid; the version and variant nibbles are not decoration.
    /// </summary>
    private static Guid DeterministicBatchId<T>(IEnumerable<T> events) where T : ITelemetryEvent
    {
        var payloads = events
            .Select(AgentJson.Serialize)
            .OrderBy(payload => payload, StringComparer.Ordinal);

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(",", payloads)));

        Span<byte> uuid = stackalloc byte[16];
        digest.AsSpan(0, 16).CopyTo(uuid);

        // Version 5 (name-based), RFC 4122 variant.
        uuid[6] = (byte)((uuid[6] & 0x0F) | 0x50);
        uuid[8] = (byte)((uuid[8] & 0x3F) | 0x80);

        // Built from the hex text rather than `new Guid(bytes)`: that constructor reads the first
        // three fields little-endian, which would reorder the digest and make the id depend on
        // the platform's endianness rather than only on the events.
        return Guid.ParseExact(Convert.ToHexString(uuid), "N");
    }

    private async Task<PushResult> PushHalvesAsync<T>(
        TelemetryChannel channel,
        List<T> events,
        CancellationToken ct) where T : ITelemetryEvent
    {
        var midpoint = events.Count / 2;

        var first = await PushChunkAsync(channel, events[..midpoint], ct).ConfigureAwait(false);
        if (first.TransientFailure) return first;

        var second = await PushChunkAsync(channel, events[midpoint..], ct).ConfigureAwait(false);

        return new PushResult(
            [.. first.Acknowledged, .. second.Acknowledged],
            [.. first.Rejected, .. second.Rejected],
            second.TransientFailure);
    }

    /// <summary>
    /// Uploads one screenshot as multipart form data.
    ///
    /// Same three-way distinction as <see cref="PushEventsAsync"/>, for the same reason: a
    /// screenshot the server refuses must stop being retried, while one that failed because the
    /// network dropped must not.
    /// </summary>
    public async Task<UploadOutcome> UploadScreenshotAsync(
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
            return UploadOutcome.Delivered;
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

        // The field name is part of the wire contract, not a label: the server's multer handler
        // is configured for a single file under exactly "file" and rejects any other field name
        // with LIMIT_UNEXPECTED_FILE. See Backend/src/modules/ingest/upload.ts.
        content.Add(file, ScreenshotFileFieldName, Path.GetFileName(filePath));

        using var request = Authorized(HttpMethod.Post, "api/v1/screenshots");
        request.Content = content;

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await ThrowIfCredentialRejectedAsync(response, ct).ConfigureAwait(false);

        if (response.IsSuccessStatusCode) return UploadOutcome.Delivered;

        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        // Same reasoning as PushChunkAsync: a 4xx is contract drift or an unacceptable file, not
        // a transient failure, and resending the identical multipart body will fail identically.
        // Logged with the server's own explanation so the mismatch is diagnosable from the
        // agent's log file alone.
        if ((int)response.StatusCode is >= 400 and < 500)
        {
            _logger.LogError("Server rejected screenshot {Id} ({Status}): {Body}",
                clientEventId, (int)response.StatusCode, responseBody);
            return UploadOutcome.Rejected;
        }

        _logger.LogWarning("Screenshot upload failed with {Status}: {Body}",
            (int)response.StatusCode, responseBody);
        return UploadOutcome.Transient;
    }

    /// <summary>
    /// Multipart field carrying the JPEG bytes. Must match <c>upload.single(...)</c> in
    /// Backend/src/modules/ingest/upload.ts - changing either side alone breaks every upload.
    /// </summary>
    private const string ScreenshotFileFieldName = "file";

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
            "Agent is configured to talk to {Url} over plain HTTP. Telemetry is unencrypted in transit - " +
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
