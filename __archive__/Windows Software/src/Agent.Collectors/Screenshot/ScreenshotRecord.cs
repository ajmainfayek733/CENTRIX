namespace Agent.Collectors.Screenshot;

/// <summary>
/// Deliberately not an ISyncableEvent through the generic JSON outbox - the payload is a large
/// binary blob, uploaded via IBackendClient.UploadScreenshotAsync's dedicated path, not batched
/// JSON. Only this metadata plus a reference to the encrypted local file crosses that boundary.
/// </summary>
public sealed record ScreenshotRecord
{
    public required Guid ClientEventId { get; init; }

    public required string MachineId { get; init; }

    public required string UserSid { get; init; }

    public required DateTimeOffset CapturedAtUtc { get; init; }

    public required int Width { get; init; }

    public required int Height { get; init; }

    public required int MonitorCount { get; init; }

    public required string LocalEncryptedFilePath { get; init; }

    public required long EncodedSizeBytes { get; init; }
}
