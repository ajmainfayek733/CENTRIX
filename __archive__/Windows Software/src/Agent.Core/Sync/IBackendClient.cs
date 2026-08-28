using Agent.Core.Consent;
using Agent.Core.Policy;

namespace Agent.Core.Sync;

/// <summary>
/// The only surface through which the Agent talks to a backend. No collector or module calls
/// this directly - only Agent.Sync's worker. Backend now exists - see
/// docs/backend-api-specification.md and Backend/src/modules/ingest.
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

    /// <summary>POST /api/v1/consent (spec section 8) - proof of notice for the acknowledgement recorded locally.</summary>
    Task<bool> PostConsentAsync(ConsentRecord record, CancellationToken cancellationToken);
}
