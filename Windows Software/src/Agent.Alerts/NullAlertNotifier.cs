namespace Agent.Alerts;

/// <summary>Default/service-side no-op - the real notifier runs in the tray helper (Windows
/// Toast/balloon notifications need the interactive session), wired at Host composition.</summary>
public sealed class NullAlertNotifier : IAlertNotifier
{
    public Task<bool> NotifyAsync(AlertRecord alert, CancellationToken cancellationToken) => Task.FromResult(false);
}
