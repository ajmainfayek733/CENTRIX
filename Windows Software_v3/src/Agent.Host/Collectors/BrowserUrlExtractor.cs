using System.Windows.Automation;
using Agent.Core.Contracts;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Collectors;

public sealed record BrowserVisit
{
    public required BrowserKind Browser { get; init; }
    public required string RawUrl { get; init; }
    public required string Domain { get; init; }
    public required UrlProtocol Protocol { get; init; }
    public string? PageTitle { get; init; }
    public string? ProfileName { get; init; }
}

/// <summary>
/// Features.md "Browser Activity log". Reads the address bar of the focused browser window
/// through UI Automation.
///
/// UI Automation rather than reading browser history files or installing an extension: history
/// files are locked while the browser runs and lag behind by design, and an extension would
/// need per-browser packaging and could be removed by the user. UIA sees what is actually on
/// screen right now.
///
/// The tradeoff is that UIA calls cross a process boundary and can block if the browser is
/// busy, so every lookup runs under a timeout from policy (BrowserMonitor.UiaTimeoutMs) and a
/// failure degrades to "no URL this tick" rather than stalling the collector.
/// </summary>
public sealed class BrowserUrlExtractor(ILogger<BrowserUrlExtractor> logger)
{
    private readonly ILogger<BrowserUrlExtractor> _logger = logger;

    /// <summary>
    /// Consecutive failures per process name. Chromium windows that are still painting return
    /// nothing for the first tick or two; a browser that never yields a URL (an unsupported
    /// fork, a hardened build) should stop being retried every second forever.
    /// </summary>
    private readonly Dictionary<string, int> _failureCounts = new(StringComparer.OrdinalIgnoreCase);

    public BrowserVisit? TryExtract(ForegroundSnapshot snapshot, int timeoutMs, int maxRetryAttempts)
    {
        if (!snapshot.IsBrowser || snapshot.WindowHandle == IntPtr.Zero) return null;

        var browser = ForegroundWindowTracker.ClassifyBrowser(snapshot.ProcessName);
        var key = snapshot.ProcessName ?? "unknown";

        if (_failureCounts.TryGetValue(key, out var failures) && failures > maxRetryAttempts)
        {
            return null;
        }

        try
        {
            // The UIA call is run on a worker with a hard timeout. UI Automation has no
            // cancellation of its own, so a hung browser would otherwise block this thread
            // indefinitely and stop all activity tracking, not just browser tracking.
            var task = Task.Run(() => ReadAddressBar(snapshot.WindowHandle));
            if (!task.Wait(timeoutMs))
            {
                RecordFailure(key);
                _logger.LogTrace("UIA address-bar read timed out after {Timeout}ms for {Process}", timeoutMs, key);
                return null;
            }

            var raw = task.Result;
            if (string.IsNullOrWhiteSpace(raw))
            {
                RecordFailure(key);
                return null;
            }

            if (!TryNormalizeUrl(raw, out var uri)) return null;

            _failureCounts.Remove(key);

            return new BrowserVisit
            {
                Browser = browser,
                RawUrl = uri.ToString(),
                Domain = uri.Host.ToLowerInvariant(),
                Protocol = uri.Scheme == Uri.UriSchemeHttps ? UrlProtocol.Https : UrlProtocol.Http,
                PageTitle = DerivePageTitle(snapshot.WindowTitle, browser)
            };
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or AggregateException or InvalidOperationException)
        {
            // The window closed or navigated mid-read. Normal during browsing.
            RecordFailure(key);
            _logger.LogTrace(ex, "Address bar unavailable for {Process}", key);
            return null;
        }
    }

    private void RecordFailure(string key) =>
        _failureCounts[key] = _failureCounts.GetValueOrDefault(key) + 1;

    /// <summary>
    /// Finds the address bar. Chromium and Firefox both expose it as an Edit control whose
    /// value is the current URL; Chromium additionally marks it with the "Address and search
    /// bar" name, which is preferred when present because a page can contain other edits.
    /// </summary>
    private static string? ReadAddressBar(IntPtr windowHandle)
    {
        var window = AutomationElement.FromHandle(windowHandle);
        if (window is null) return null;

        var editCondition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
        var candidates = window.FindAll(TreeScope.Descendants, editCondition);

        AutomationElement? fallback = null;

        foreach (AutomationElement element in candidates)
        {
            var name = element.Current.Name ?? string.Empty;

            var looksLikeAddressBar =
                name.Contains("Address", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("Search with", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("Search or enter", StringComparison.OrdinalIgnoreCase);

            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern)) continue;
            var value = ((ValuePattern)pattern).Current.Value;
            if (string.IsNullOrWhiteSpace(value)) continue;

            if (looksLikeAddressBar) return value;
            fallback ??= element;
        }

        if (fallback is not null && fallback.TryGetCurrentPattern(ValuePattern.Pattern, out var fallbackPattern))
        {
            return ((ValuePattern)fallbackPattern).Current.Value;
        }

        return null;
    }

    /// <summary>
    /// Turns what the address bar shows into an absolute URL. Browsers hide the scheme, so
    /// "github.com/anthropics" needs https:// prepended before it will parse.
    ///
    /// Only http and https are recorded. A file:// path or a chrome://settings page is local
    /// navigation, not web browsing, and logging file paths would capture document names the
    /// spec's purpose-limitation rule (section 3.1) does not cover.
    /// </summary>
    private static bool TryNormalizeUrl(string raw, out Uri uri)
    {
        uri = null!;
        var trimmed = raw.Trim();
        if (trimmed.Length == 0) return false;

        if (!trimmed.Contains("://", StringComparison.Ordinal))
        {
            // A bare search phrase is not a URL. Requiring a dot before the first slash keeps
            // "how do I center a div" out while letting "github.com/anthropics" through.
            var firstSlash = trimmed.IndexOf('/');
            var authority = firstSlash < 0 ? trimmed : trimmed[..firstSlash];
            if (!authority.Contains('.')) return false;

            trimmed = "https://" + trimmed;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return false;
        if (string.IsNullOrWhiteSpace(parsed.Host)) return false;

        uri = parsed;
        return true;
    }

    /// <summary>
    /// Browser window titles are "Page title - Browser Name" (or " — Mozilla Firefox").
    /// Strips the browser suffix so the stored page title is just the page.
    /// </summary>
    private static string? DerivePageTitle(string windowTitle, BrowserKind browser)
    {
        if (string.IsNullOrWhiteSpace(windowTitle)) return null;

        string[] suffixes = browser switch
        {
            BrowserKind.Chrome => [" - Google Chrome"],
            BrowserKind.Edge => [" - Microsoft​ Edge", " - Microsoft Edge"],
            BrowserKind.Firefox => [" — Mozilla Firefox", " - Mozilla Firefox"],
            BrowserKind.Brave => [" - Brave"],
            BrowserKind.Opera => [" - Opera"],
            BrowserKind.Vivaldi => [" - Vivaldi"],
            _ => []
        };

        foreach (var suffix in suffixes)
        {
            if (windowTitle.EndsWith(suffix, StringComparison.Ordinal))
            {
                return windowTitle[..^suffix.Length];
            }
        }

        return windowTitle;
    }
}
