namespace Agent.Alerts;

public interface IAlertRepository
{
    /// <summary>The currently open (not Resolved/Archived) alert of this type for this
    /// machine+user, if any — used to decide "new alert" vs. "escalate existing."</summary>
    Task<AlertRecord?> FindOpenAlertAsync(string machineId, string userSid, AlertType type, CancellationToken cancellationToken);

    /// <summary>Alerts due for on-screen notification, regardless of which process (service or
    /// tray helper) created them — the tray helper's poller is the sole notification display
    /// point since only it can show UI in the interactive session.</summary>
    Task<IReadOnlyList<AlertRecord>> GetDueForNotificationAsync(DateTimeOffset nowUtc, TimeSpan renotifyInterval, CancellationToken cancellationToken);

    Task SaveNewAsync(AlertRecord alert, CancellationToken cancellationToken);

    Task EscalateAsync(Guid alertId, AlertSeverity newSeverity, string message, DateTimeOffset atUtc, CancellationToken cancellationToken);

    Task RecordNotificationAsync(Guid alertId, DateTimeOffset atUtc, CancellationToken cancellationToken);

    Task AcknowledgeAsync(Guid alertId, DateTimeOffset atUtc, CancellationToken cancellationToken);

    Task ResolveAsync(Guid alertId, DateTimeOffset atUtc, CancellationToken cancellationToken);
}

public interface IAlertNotifier
{
    /// <returns>True if the alert was actually displayed. The no-op Host-side notifier returns
    /// false so AlertEngine never marks an alert "notified" when nothing was shown — the tray
    /// helper's poller is what actually notifies, via <see cref="IAlertRepository.GetDueForNotificationAsync"/>.</returns>
    Task<bool> NotifyAsync(AlertRecord alert, CancellationToken cancellationToken);
}
