using Agent.Core.Policy;

namespace Agent.Core.Sync;

/// <summary>
/// The only surface through which the Agent talks to a backend. No collector or module calls
/// this directly — only Agent.Sync's worker. Real backend does not exist yet; the contract here
/// is what docs/backend-api-specification.md is written against.
/// </summary>
public interface IBackendClient
{
    Task<BackendAckResult> PushEventsAsync(
        string channel,
        IReadOnlyList<OutboxPayload> events,
        CancellationToken cancellationToken);

    Task<PolicyDocument> GetPolicyAsync(CancellationToken cancellationToken);

    Task<ScreenshotUploadResult> UploadScreenshotAsync(
        ScreenshotUploadRequest request,
        CancellationToken cancellationToken);
}
