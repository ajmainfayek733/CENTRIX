namespace Agent.Core.Sync;

public sealed record OutboxPayload(Guid ClientEventId, string PayloadJson);

public sealed record BackendAckResult(bool Success, IReadOnlyList<Guid> AcknowledgedEventIds, string? Error);

public sealed record ScreenshotUploadRequest(
    Guid ClientEventId,
    string MachineId,
    DateTimeOffset CapturedAtUtc,
    string LocalFilePath,
    string ContentType);

public sealed record ScreenshotUploadResult(bool Success, string? RemoteUri, string? Error);
