using System.Collections.Concurrent;
using System.Runtime.InteropServices;
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
/// THE COST MODEL, because this is the most expensive thing the agent does. Every UIA call is a
/// blocking cross-process request into the browser, and a full descendant search of a browser
/// window can visit thousands of elements. Three mechanisms keep that bounded:
///
///   1. One reader thread for the whole process. A browser that stops answering blocks that one
///      thread and nothing else; further requests are refused outright rather than queued, so a
///      wedged browser cannot accumulate work.
///   2. The address bar element is cached per window. After the first search, reading the current
///      URL is a single property fetch instead of a tree walk.
///   3. The search itself runs under a CacheRequest, so each candidate's name and value arrive in
///      the same round trip that found it rather than costing two more each.
///
/// The caller decides *when* to ask (see MonitoringOrchestrator's probe gating); this class only
/// guarantees that asking is as cheap as it can be and can never stall the monitoring loop.
/// </summary>
public sealed class BrowserUrlExtractor : IDisposable
{
    private readonly ILogger<BrowserUrlExtractor> _logger;

    /// <summary>
    /// Requests handed to the reader thread. Depth is capped at one by <see cref="_readInFlight"/>
    /// rather than by the collection, so a submission never blocks the monitoring loop.
    /// </summary>
    private readonly BlockingCollection<ReadRequest> _requests = [];
    private readonly Thread _reader;

    /// <summary>1 while the reader is inside UI Automation. Guards against a second submission.</summary>
    private int _readInFlight;

    /// <summary>Set if the reader thread ever exits. Extraction then degrades to "no URL", permanently.</summary>
    private volatile bool _readerStopped;
    private volatile bool _disposed;

    /// <summary>
    /// Consecutive failures per process name, and the point after which a hopeless browser is
    /// tried again.
    ///
    /// Chromium windows that are still painting return nothing for the first probe or two, which
    /// is a retry. A browser that never yields a URL at all - an unsupported fork, a hardened
    /// build, a window whose address bar is hidden by policy - is a different case, and probing it
    /// every few seconds forever would be pure waste. After the retry budget is spent it is left
    /// alone for a cooldown and then given another chance, so the suppression heals itself if the
    /// cause was temporary.
    /// </summary>
    private readonly Dictionary<string, BrowserProbeState> _probeState = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan FailureCooldown = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Resolved address bars by window handle. Chromium and Firefox both keep one omnibox element
    /// for the life of a window, across every navigation and tab switch in it, which is what makes
    /// this worth caching at all.
    /// </summary>
    private readonly Dictionary<IntPtr, ValuePattern> _addressBars = [];
    private const int AddressBarCacheLimit = 32;

    private const string UnknownProcessKey = "unknown";

    private sealed record ReadRequest(IntPtr WindowHandle, bool UseCachedElement, TaskCompletionSource<string?> Completion);

    private sealed class BrowserProbeState
    {
        public int ConsecutiveFailures { get; set; }
        public DateTimeOffset SuppressedUntil { get; set; } = DateTimeOffset.MinValue;
    }

    public BrowserUrlExtractor(ILogger<BrowserUrlExtractor> logger)
    {
        _logger = logger;

        // MTA, which is what UI Automation clients are expected to use: an STA reader would have
        // to pump messages to avoid deadlocking against the browser's own UI thread.
        _reader = new Thread(RunReader)
        {
            IsBackground = true,
            Name = "uia-address-bar-reader"
        };
        _reader.SetApartmentState(ApartmentState.MTA);
        _reader.Start();
    }

    /// <summary>
    /// Reads the focused browser's current URL, or null when there is nothing to report.
    ///
    /// Never throws and never blocks longer than <paramref name="timeoutMs"/>. A timeout leaves
    /// the reader working in the background; the next call is refused until it finishes, which is
    /// the intended back-pressure.
    /// </summary>
    public async Task<BrowserVisit?> TryExtractAsync(
        ForegroundSnapshot snapshot, int timeoutMs, int maxRetryAttempts, CancellationToken ct)
    {
        if (_disposed || _readerStopped) return null;
        if (!snapshot.IsBrowser || snapshot.WindowHandle == IntPtr.Zero) return null;

        var key = snapshot.ProcessName ?? UnknownProcessKey;
        var now = DateTimeOffset.UtcNow;
        if (IsSuppressed(key, now)) return null;

        // One reader, ever. If the previous read has not come back the browser is not answering,
        // and starting another would add a thread per tick while the first is still stuck.
        if (Interlocked.CompareExchange(ref _readInFlight, 1, 0) != 0)
        {
            _logger.LogTrace("Skipping the address bar of {Process}; the previous read is still running", key);
            return null;
        }

        var completion = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);

        // Read after taking the slot, never before: holding the slot is what proves the reader is
        // between requests and therefore not touching the cache. The interlocked exchange on both
        // sides is what publishes the reader's writes to this thread.
        var useCachedElement = _addressBars.ContainsKey(snapshot.WindowHandle);

        try
        {
            _requests.Add(new ReadRequest(snapshot.WindowHandle, useCachedElement, completion), CancellationToken.None);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            // The collection was completed by Dispose between the checks above and here.
            Interlocked.Exchange(ref _readInFlight, 0);
            return null;
        }

        string? raw;
        try
        {
            raw = await completion.Task.WaitAsync(TimeSpan.FromMilliseconds(timeoutMs), ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            RecordFailure(key, maxRetryAttempts, now);
            _logger.LogTrace("Address-bar read timed out after {Timeout}ms for {Process}", timeoutMs, key);
            return null;
        }
        catch (OperationCanceledException)
        {
            // Shutdown. Not a browser failure, so it must not count against the retry budget.
            return null;
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or COMException or InvalidOperationException)
        {
            // The window closed or navigated mid-read. Normal during browsing.
            InvalidateAddressBar(snapshot.WindowHandle);
            RecordFailure(key, maxRetryAttempts, now);
            _logger.LogTrace(ex, "Address bar unavailable for {Process}", key);
            return null;
        }

        if (string.IsNullOrWhiteSpace(raw))
        {
            RecordFailure(key, maxRetryAttempts, now);
            return null;
        }

        // A URL that will not parse is not a browser failure - it is a search phrase, an internal
        // page or a local file, all of which are deliberately not recorded. Clearing the failure
        // count is right: the address bar answered.
        _probeState.Remove(key);

        if (!TryNormalizeUrl(raw, out var uri)) return null;

        var browser = ForegroundWindowTracker.ClassifyBrowser(snapshot.ProcessName);

        return new BrowserVisit
        {
            Browser = browser,
            RawUrl = uri.ToString(),
            Domain = uri.Host.ToLowerInvariant(),
            Protocol = uri.Scheme == Uri.UriSchemeHttps ? UrlProtocol.Https : UrlProtocol.Http,
            PageTitle = DerivePageTitle(snapshot.WindowTitle, browser)
        };
    }

    private bool IsSuppressed(string key, DateTimeOffset now) =>
        _probeState.TryGetValue(key, out var state) && now < state.SuppressedUntil;

    private void RecordFailure(string key, int maxRetryAttempts, DateTimeOffset now)
    {
        if (!_probeState.TryGetValue(key, out var state))
        {
            state = new BrowserProbeState();
            _probeState[key] = state;
        }

        state.ConsecutiveFailures++;

        if (state.ConsecutiveFailures <= maxRetryAttempts) return;

        state.ConsecutiveFailures = 0;
        state.SuppressedUntil = now + FailureCooldown;

        _logger.LogDebug(
            "No URL from {Process} after {Attempts} attempts; not probing it again for {Cooldown}",
            key, maxRetryAttempts + 1, FailureCooldown);
    }

    // -- Reader thread -------------------------------------------------------

    private void RunReader()
    {
        try
        {
            foreach (var request in _requests.GetConsumingEnumerable())
            {
                try
                {
                    request.Completion.TrySetResult(ReadUrl(request));
                }
                catch (Exception ex)
                {
                    // Handed to the caller rather than logged here: only the caller knows which
                    // browser it asked about, and it may already have timed out and moved on.
                    request.Completion.TrySetException(ex);
                }
                finally
                {
                    Interlocked.Exchange(ref _readInFlight, 0);
                }
            }
        }
        catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException)
        {
            // Normal shutdown: the collection was completed and disposed.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "The address-bar reader stopped; browser URLs will no longer be recorded");
        }
        finally
        {
            _readerStopped = true;
            Interlocked.Exchange(ref _readInFlight, 0);
        }
    }

    /// <summary>
    /// Runs on the reader thread. Tries the cached address bar first and falls back to searching
    /// the window when there is no cache entry or the cached element has gone.
    /// </summary>
    private string? ReadUrl(ReadRequest request)
    {
        if (request.UseCachedElement && _addressBars.TryGetValue(request.WindowHandle, out var cached))
        {
            try
            {
                return cached.Current.Value;
            }
            catch (Exception ex) when (ex is ElementNotAvailableException or COMException)
            {
                // The window was closed or the browser rebuilt its toolbar. Search again.
                _addressBars.Remove(request.WindowHandle);
            }
        }

        var (value, element) = FindAddressBar(request.WindowHandle);
        if (element is not null) CacheAddressBar(request.WindowHandle, element);

        return value;
    }

    /// <summary>
    /// Finds the address bar. Chromium and Firefox both expose it as an Edit control whose
    /// value is the current URL; Chromium additionally marks it with the "Address and search
    /// bar" name, which is preferred when present because a page can contain other edits.
    ///
    /// Every candidate's name and value are pulled in the same round trip as the search itself.
    /// Reading them through Current instead would turn one cross-process call into two per
    /// element, on a tree that can be thousands of elements wide.
    /// </summary>
    private static (string? Value, ValuePattern? Element) FindAddressBar(IntPtr windowHandle)
    {
        var window = AutomationElement.FromHandle(windowHandle);
        if (window is null) return (null, null);

        var cacheRequest = new CacheRequest
        {
            TreeScope = TreeScope.Element,
            AutomationElementMode = AutomationElementMode.Full
        };
        cacheRequest.Add(AutomationElement.NameProperty);
        cacheRequest.Add(ValuePattern.Pattern);
        cacheRequest.Add(ValuePattern.ValueProperty);

        AutomationElementCollection candidates;
        using (cacheRequest.Activate())
        {
            var editCondition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
            candidates = window.FindAll(TreeScope.Descendants, editCondition);
        }

        (string Value, ValuePattern Element)? fallback = null;

        foreach (AutomationElement element in candidates)
        {
            if (!element.TryGetCachedPattern(ValuePattern.Pattern, out var pattern)) continue;
            if (pattern is not ValuePattern valuePattern) continue;

            var value = valuePattern.Cached.Value;
            if (string.IsNullOrWhiteSpace(value)) continue;

            var name = element.Cached.Name ?? string.Empty;

            var looksLikeAddressBar =
                name.Contains("Address", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("Search with", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("Search or enter", StringComparison.OrdinalIgnoreCase);

            if (looksLikeAddressBar) return (value, valuePattern);
            fallback ??= (value, valuePattern);
        }

        return fallback is { } found ? (found.Value, found.Element) : (null, null);
    }

    private void CacheAddressBar(IntPtr windowHandle, ValuePattern element)
    {
        // Browser windows come and go; the cache must not grow with them. Clearing wholesale is
        // adequate because a rebuilt entry costs exactly one search.
        if (_addressBars.Count >= AddressBarCacheLimit) _addressBars.Clear();
        _addressBars[windowHandle] = element;
    }

    /// <summary>
    /// Drops a cached address bar from the calling thread. Safe against the reader because the
    /// caller only reaches this while holding the in-flight slot, so the reader is idle.
    /// </summary>
    private void InvalidateAddressBar(IntPtr windowHandle) => _addressBars.Remove(windowHandle);

    // -- Parsing -------------------------------------------------------------

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
    /// Browser window titles are "Page title - Browser Name" (or " - Mozilla Firefox").
    /// Strips the browser suffix so the stored page title is just the page.
    /// </summary>
    private static string? DerivePageTitle(string windowTitle, BrowserKind browser)
    {
        if (string.IsNullOrWhiteSpace(windowTitle)) return null;

        var suffix = browser switch
        {
            BrowserKind.Chrome => " - Google Chrome",
            BrowserKind.Edge => " - Microsoft Edge",
            BrowserKind.Firefox => " - Mozilla Firefox",
            BrowserKind.Brave => " - Brave",
            BrowserKind.Opera => " - Opera",
            BrowserKind.Vivaldi => " - Vivaldi",
            _ => null
        };

        return suffix is not null && windowTitle.EndsWith(suffix, StringComparison.Ordinal)
            ? windowTitle[..^suffix.Length]
            : windowTitle;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _requests.CompleteAdding();

        // Not joined: the reader may be blocked inside a browser that is not answering, and
        // logoff must not wait for it. It holds nothing that needs releasing and the process is
        // about to exit, so a background thread left in a UIA call is harmless.
        _requests.Dispose();
    }
}
