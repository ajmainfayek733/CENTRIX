namespace Agent.Collectors.AppSession;

public interface IAppSessionRepository
{
    /// <summary>Persists the session immediately with EndTimeUtc null, before it's known how it ends.</summary>
    Task OpenAsync(AppSessionRecord openSession, CancellationToken cancellationToken);

    /// <summary>
    /// Completes the row in place and only then enqueues it to the sync outbox — the backend
    /// never sees a session before it's finished.
    /// </summary>
    Task CloseAsync(Guid clientEventId, DateTimeOffset endTimeUtc, string? productivityTag, CancellationToken cancellationToken);

    Task<IReadOnlyList<AppSessionRecord>> GetOpenSessionsAsync(CancellationToken cancellationToken);
}
