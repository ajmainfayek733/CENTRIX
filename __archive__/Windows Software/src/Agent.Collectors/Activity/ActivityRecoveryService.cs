using Agent.Core.Time;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Activity;

public sealed class ActivityRecoveryService(
    IActivityRepository repository,
    ISystemClock clock,
    ILogger<ActivityRecoveryService> logger)
{
    public async Task RecoverAsync(CancellationToken cancellationToken)
    {
        var nowUtc = clock.UtcNow;
        var openSessions = await repository.GetOpenSessionsAsync(cancellationToken).ConfigureAwait(false);

        foreach (var session in openSessions)
        {
            logger.LogWarning(
                "Recovering dangling open activity session {ClientEventId} ({State}) started {StartUtc}.",
                session.ClientEventId,
                session.State,
                session.StartTimeUtc);

            await repository.CloseAsync(session.ClientEventId, nowUtc, cancellationToken).ConfigureAwait(false);
        }
    }
}
