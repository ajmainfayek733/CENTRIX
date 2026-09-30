using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Time;
using Agent.Native;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Collectors.Browser;

/// <summary>
/// Polls the foreground window at the same cadence as App Session; when it's a known browser
/// and the window title has changed since the last check (Chromium/Firefox titles reflect the
/// active page, so a navigation always changes it), re-reads the address bar via UI Automation.
/// This avoids continuous UIA polling - a real cost driver against the CPU budget - while still
/// catching every navigation.
/// </summary>
public sealed class BrowserMonitorCollectorService(
    IForegroundWindowMonitor foregroundWindowMonitor,
    IBrowserDetector browserDetector,
    IBrowserAutomation browserAutomation,
    IUriNormalizer uriNormalizer,
    IDomainExtractor domainExtractor,
    IUrlValidator urlValidator,
    IDeviceContextProvider deviceContext,
    IBrowserMonitorRepository repository,
    IPolicyProvider policyProvider,
    ISystemClock clock,
    ILogger<BrowserMonitorCollectorService> logger) : IHostedService, IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    private Timer? _pollTimer;
    private string? _lastCheckedWindowTitle;
    private string _userSid = string.Empty;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _pollTimer = new Timer(_ => _ = PollAsync(), null, PollInterval, PollInterval);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _pollTimer?.Dispose();
        return Task.CompletedTask;
    }

    public void Dispose() => _pollTimer?.Dispose();

    private async Task PollAsync()
    {
        var policy = policyProvider.Current.BrowserMonitor;
        if (!policy.Enabled)
        {
            return;
        }

        var snapshot = foregroundWindowMonitor.GetCurrentForegroundWindow();
        if (snapshot is null)
        {
            return;
        }

        var browserType = browserDetector.Detect(snapshot.ExecutablePath);
        if (browserType == BrowserType.Unknown)
        {
            _lastCheckedWindowTitle = null;
            return;
        }

        if (string.Equals(snapshot.WindowTitle, _lastCheckedWindowTitle, StringComparison.Ordinal))
        {
            return;
        }

        _lastCheckedWindowTitle = snapshot.WindowTitle;

        var rawUrl = await ExtractWithRetryAsync(browserType, policy).ConfigureAwait(false);
        if (rawUrl is null)
        {
            return;
        }

        await RecordNavigationAsync(browserType, rawUrl).ConfigureAwait(false);
    }

    private async Task<string?> ExtractWithRetryAsync(BrowserType browserType, BrowserMonitorPolicy policy)
    {
        // Foreground window handle is re-fetched per attempt: a stale handle across retries
        // could point at a window the user already navigated away from or closed.
        for (var attempt = 0; attempt < Math.Max(1, policy.MaxRetryAttempts); attempt++)
        {
            var snapshot = foregroundWindowMonitor.GetCurrentForegroundWindow();
            if (snapshot is null || browserDetector.Detect(snapshot.ExecutablePath) != browserType)
            {
                return null;
            }

            var extraction = Task.Run(() => browserAutomation.TryExtractUrl(snapshot.WindowHandle, browserType));
            var completed = await Task.WhenAny(extraction, Task.Delay(policy.UiaTimeout)).ConfigureAwait(false);

            if (completed == extraction && extraction.Result is { } url)
            {
                return url;
            }
        }

        return null;
    }

    private async Task RecordNavigationAsync(BrowserType browserType, string rawUrl)
    {
        var classification = urlValidator.Classify(rawUrl);
        var normalized = uriNormalizer.Normalize(rawUrl);
        var domain = domainExtractor.ExtractDomain(normalized);

        var navigationEvent = new BrowserNavigationEvent
        {
            ClientEventId = Guid.NewGuid(),
            MachineId = deviceContext.Current.MachineId,
            UserSid = _userSid,
            Browser = browserType,
            RawUrl = rawUrl,
            NormalizedUrl = normalized,
            Domain = domain,
            Category = classification.Category,
            OccurredAtUtc = clock.UtcNow
        };

        try
        {
            await repository.RecordAsync(navigationEvent, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to persist browser navigation event for {Browser}.", browserType);
        }
    }
}
