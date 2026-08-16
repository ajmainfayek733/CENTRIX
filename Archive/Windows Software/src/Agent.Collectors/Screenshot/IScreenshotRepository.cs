namespace Agent.Collectors.Screenshot;

public interface IScreenshotRepository
{
    Task SaveAsync(ScreenshotRecord record, CancellationToken cancellationToken);

    Task<IReadOnlyList<ScreenshotRecord>> GetPendingUploadsAsync(int maxBatchSize, CancellationToken cancellationToken);

    /// <summary>Deletes the row and the local encrypted file - retention is "delete on sync ack."</summary>
    Task MarkUploadedAsync(Guid clientEventId, CancellationToken cancellationToken);

    Task<int> PurgeExpiredUnuploadedAsync(TimeSpan maxAge, CancellationToken cancellationToken);
}
