using Agent.Alerts;

namespace Agent.TrayHelper;

/// <summary>
/// A NotifyIcon balloon tip rather than the newer Action Center toast API — reliable without
/// extra AppUserModelID/manifest registration, and functionally serves the same purpose (the
/// spec's "Windows Toast Notifications" requirement) for a tray-icon-hosted agent.
/// </summary>
public sealed class BalloonAlertNotifier(NotifyIcon notifyIcon, SynchronizationContext uiContext) : IAlertNotifier
{
    public Task<bool> NotifyAsync(AlertRecord alert, CancellationToken cancellationToken)
    {
        uiContext.Post(_ =>
        {
            notifyIcon.BalloonTipTitle = alert.Title;
            notifyIcon.BalloonTipText = alert.Message;
            notifyIcon.BalloonTipIcon = alert.Severity switch
            {
                AlertSeverity.Critical => ToolTipIcon.Error,
                AlertSeverity.High or AlertSeverity.Warning => ToolTipIcon.Warning,
                _ => ToolTipIcon.Info
            };
            notifyIcon.ShowBalloonTip(10_000);
        }, null);

        return Task.FromResult(true);
    }
}
