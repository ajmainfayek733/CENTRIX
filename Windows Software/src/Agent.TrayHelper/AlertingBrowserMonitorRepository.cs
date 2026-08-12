using Agent.Alerts;
using Agent.Collectors.Browser;

namespace Agent.TrayHelper;

/// <summary>Same decorator pattern as Agent.Host's AlertingUsbLogRepository - Agent.Collectors
/// has no dependency on Agent.Alerts, so the alert-engine hook happens here.</summary>
public sealed class AlertingBrowserMonitorRepository(IBrowserMonitorRepository inner, AlertEngine<BrowserNavigationEvent> alertEngine) : IBrowserMonitorRepository
{
    public async Task RecordAsync(BrowserNavigationEvent navigationEvent, CancellationToken cancellationToken)
    {
        await inner.RecordAsync(navigationEvent, cancellationToken).ConfigureAwait(false);
        await alertEngine.ProcessAsync(navigationEvent, navigationEvent.MachineId, navigationEvent.UserSid, cancellationToken).ConfigureAwait(false);
    }
}
