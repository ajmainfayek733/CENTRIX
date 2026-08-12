namespace Agent.Core.Consent;

/// <summary>
/// Lets network-facing hosted services (SyncWorker, ScreenshotUploadWorker) hold off on
/// transmitting data until consent has been acknowledged, without those services having to poll
/// the consent store themselves. Agent.Host has no interactive UI to show the consent dialog
/// itself (that's Agent.TrayHelper's job, once a user is logged in), so this is populated from a
/// background poll of the shared consent store - see ConsentGateHostedService.
/// </summary>
public interface IConsentGate
{
    bool IsAcknowledged { get; }
}

public sealed class ConsentGate : IConsentGate
{
    private volatile bool _isAcknowledged;

    public bool IsAcknowledged => _isAcknowledged;

    public void Grant() => _isAcknowledged = true;
}
