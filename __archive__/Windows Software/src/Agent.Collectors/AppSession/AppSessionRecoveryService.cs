using Agent.Core.Time;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.AppSession;

/// <summary>
/// Runs once at startup. Unlike Attendance, no synthetic "reopen" is needed here - the poller's
/// very next observation naturally opens a fresh session - so this only closes the dangling row.
/// </summary>
public sealed class AppSessionRecoveryService(
    IAppSessionRepository repository,
    ISystemClock clock,
    ILogger<AppSessionRecoveryService> logger)
{
    public async Task RecoverAsync(CancellationToken cancellationToken)
    {
        var nowUtc = clock.UtcNow;
        var openSessions = await repository.GetOpenSessionsAsync(cancellationToken).ConfigureAwait(false);

        foreach (var session in openSessions)
        {
            logger.LogWarning(
                "Recovering dangling open app session {ClientEventId} ({Executable}) started {StartUtc}.",
                session.ClientEventId,
                session.Executable,
                session.StartTimeUtc);

            await repository.CloseAsync(session.ClientEventId, nowUtc, session.ProductivityTag, cancellationToken).ConfigureAwait(false);
        }
    }
}
