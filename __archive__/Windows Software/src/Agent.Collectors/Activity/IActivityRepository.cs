namespace Agent.Collectors.Activity;

public interface IActivityRepository
{
    Task OpenAsync(ActivitySessionRecord openSession, CancellationToken cancellationToken);

    Task CloseAsync(Guid clientEventId, DateTimeOffset endTimeUtc, CancellationToken cancellationToken);

    Task<IReadOnlyList<ActivitySessionRecord>> GetOpenSessionsAsync(CancellationToken cancellationToken);
}
