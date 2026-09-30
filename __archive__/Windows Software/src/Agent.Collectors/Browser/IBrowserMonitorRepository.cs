namespace Agent.Collectors.Browser;

public interface IBrowserMonitorRepository
{
    Task RecordAsync(BrowserNavigationEvent navigationEvent, CancellationToken cancellationToken);
}
