using System.Net.Http.Headers;
using System.Net.Http.Json;
using Agent.Core.Policy;
using Agent.Core.Sync;

namespace Agent.Sync;

/// <summary>
/// The concrete IBackendClient the brief calls for — built against the contract documented in
/// docs/backend-api-specification.md so it's ready to point at the real backend once one exists.
/// Authentication (bearer token acquisition/rotation) is expected to be configured on the
/// injected HttpClient (BaseAddress + default Authorization header) by the composition root,
/// since the concrete auth flow depends on backend decisions not yet made.
/// </summary>
public sealed class HttpBackendClient(HttpClient httpClient) : IBackendClient
{
    public async Task<BackendAckResult> PushEventsAsync(string channel, IReadOnlyList<OutboxPayload> events, CancellationToken cancellationToken)
    {
        try
        {
            var requestBody = new PushEventsRequest(events.Select(e => new PushEventItem(e.ClientEventId, e.PayloadJson)).ToList());
            using var response = await httpClient.PostAsJsonAsync($"/api/v1/events/{channel}", requestBody, cancellationToken).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                return new BackendAckResult(false, [], $"HTTP {(int)response.StatusCode}");
            }

            var result = await response.Content.ReadFromJsonAsync<PushEventsResponse>(cancellationToken).ConfigureAwait(false);
            return new BackendAckResult(true, result?.AcknowledgedEventIds ?? [], null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return new BackendAckResult(false, [], ex.Message);
        }
    }

    public async Task<PolicyDocument> GetPolicyAsync(CancellationToken cancellationToken)
    {
        var policy = await httpClient.GetFromJsonAsync<PolicyDocument>("/api/v1/policy", cancellationToken).ConfigureAwait(false);
        return policy ?? PolicyDocument.Default;
    }

    public async Task<ScreenshotUploadResult> UploadScreenshotAsync(ScreenshotUploadRequest request, CancellationToken cancellationToken)
    {
        try
        {
            using var content = new MultipartFormDataContent();
            await using var fileStream = File.OpenRead(request.LocalFilePath);
            using var fileContent = new StreamContent(fileStream);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue(request.ContentType);

            content.Add(fileContent, "file", Path.GetFileName(request.LocalFilePath));
            content.Add(new StringContent(request.ClientEventId.ToString()), "clientEventId");
            content.Add(new StringContent(request.MachineId), "machineId");
            content.Add(new StringContent(request.CapturedAtUtc.ToString("O")), "capturedAtUtc");

            using var response = await httpClient.PostAsync("/api/v1/screenshots", content, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return new ScreenshotUploadResult(false, null, $"HTTP {(int)response.StatusCode}");
            }

            var result = await response.Content.ReadFromJsonAsync<UploadScreenshotResponse>(cancellationToken).ConfigureAwait(false);
            return new ScreenshotUploadResult(true, result?.RemoteUri, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            return new ScreenshotUploadResult(false, null, ex.Message);
        }
    }

    private sealed record PushEventsRequest(IReadOnlyList<PushEventItem> Events);

    private sealed record PushEventItem(Guid ClientEventId, string PayloadJson);

    private sealed record PushEventsResponse(IReadOnlyList<Guid> AcknowledgedEventIds);

    private sealed record UploadScreenshotResponse(string? RemoteUri);
}
