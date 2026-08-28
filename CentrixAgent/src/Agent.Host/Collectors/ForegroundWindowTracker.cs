using System.IO;
using System.Diagnostics;
using Agent.Host.Interop;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Collectors;

/// <summary>What is on screen right now, resolved from the foreground window.</summary>
public sealed record ForegroundSnapshot
{
    public required string? AppName { get; init; }
    public required string? ProcessName { get; init; }
    public required string? ExecutablePath { get; init; }
    public required string WindowTitle { get; init; }
    public required IntPtr WindowHandle { get; init; }

    /// <summary>True when the foreground process is a browser we know how to read a URL from.</summary>
    public bool IsBrowser { get; init; }

    /// <summary>
    /// Two snapshots represent the same activity session when the process and the window title
    /// both match. Title is included because a browser or editor staying focused while the user
    /// moves between tabs or files is genuinely different activity.
    /// </summary>
    public bool IsSameActivityAs(ForegroundSnapshot? other) =>
        other is not null &&
        string.Equals(ProcessName, other.ProcessName, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(WindowTitle, other.WindowTitle, StringComparison.Ordinal);
}

/// <summary>
/// Reads the foreground application. Features.md "Activity Logs" wants app name, process name,
/// executable path and window title, and the duration each stays in focus.
///
/// This runs on every monitoring tick - once a second by default - so the cost of a single
/// capture is the agent's steady-state CPU floor. Two things keep it near zero:
///
///   1. The unconditional work is four Win32 calls (foreground handle, owning process id, title
///      length, title text). None of them leave the kernel's window station data.
///   2. Everything expensive is cached behind process identity: the executable path is read once
///      per process instance, and the friendly name once per executable, because neither can
///      change while a process is alive.
/// </summary>
public sealed class ForegroundWindowTracker(ILogger<ForegroundWindowTracker> logger)
{
    private readonly ILogger<ForegroundWindowTracker> _logger = logger;

    /// <summary>
    /// Process names we can extract a URL from. Matched case-insensitively against the process
    /// name without extension.
    /// </summary>
    private static readonly Dictionary<string, Agent.Core.Contracts.BrowserKind> KnownBrowsers = new(StringComparer.OrdinalIgnoreCase)
    {
        ["chrome"] = Agent.Core.Contracts.BrowserKind.Chrome,
        ["msedge"] = Agent.Core.Contracts.BrowserKind.Edge,
        ["firefox"] = Agent.Core.Contracts.BrowserKind.Firefox,
        ["brave"] = Agent.Core.Contracts.BrowserKind.Brave,
        ["opera"] = Agent.Core.Contracts.BrowserKind.Opera,
        ["vivaldi"] = Agent.Core.Contracts.BrowserKind.Vivaldi
    };

    /// <summary>
    /// Resolved executables, keyed by process id and validated against the process start time.
    ///
    /// Keying on the id alone is not safe. Windows reuses process ids, so an entry left behind by
    /// an exited process would silently attribute the new owner's foreground time to the old
    /// application - a wrong answer that looks entirely plausible in a report. Storing the start
    /// time turns that into a cheap miss: the ids match, the instants do not, and the entry is
    /// replaced.
    /// </summary>
    private readonly Dictionary<uint, ProcessIdentity> _processCache = [];

    /// <summary>
    /// Friendly names by executable path. Separate from the process cache because reading a file
    /// version resource touches the disk: keyed by path it happens once per application for the
    /// life of the session, rather than once per process instance. Chrome alone would otherwise
    /// pay it for every renderer that reaches the foreground.
    /// </summary>
    private readonly Dictionary<string, string?> _descriptionCache = new(StringComparer.OrdinalIgnoreCase);

    private const int ProcessCacheLimit = 256;
    private const int DescriptionCacheLimit = 512;

    /// <summary>An executable resolved from a live process, with the identity that validates it.</summary>
    private readonly record struct ProcessIdentity(long StartedAtTicks, string? Path, string? Name);

    // The previous capture, memoised so that staying in one window - which is what a working day
    // mostly consists of - costs nothing beyond reading the handle, its owner and its title.
    private IntPtr _lastWindow = IntPtr.Zero;
    private uint _lastPid;
    private ProcessIdentity _lastIdentity;
    private string? _lastDescription;

    public static Agent.Core.Contracts.BrowserKind ClassifyBrowser(string? processName) =>
        processName is not null && KnownBrowsers.TryGetValue(processName, out var kind)
            ? kind
            : Agent.Core.Contracts.BrowserKind.Other;

    public ForegroundSnapshot? Capture()
    {
        var hWnd = NativeMethods.GetForegroundWindow();

        // No foreground window means the desktop has focus, or the secure desktop is up
        // (UAC prompt, Ctrl+Alt+Del). Either way there is no application to attribute time to.
        if (hWnd == IntPtr.Zero) return null;

        NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
        if (pid == 0) return null;

        var title = NativeMethods.GetWindowTitle(hWnd);

        // Same window, same owner as the previous tick: the executable behind it cannot have
        // changed. A process would have to exit and a new one both inherit its id and adopt its
        // window handle within one tick for this to be wrong. Only the title is re-read, because
        // that is the one thing that does change while a window stays focused.
        ProcessIdentity identity;
        string? description;

        if (hWnd == _lastWindow && pid == _lastPid)
        {
            identity = _lastIdentity;
            description = _lastDescription;
        }
        else
        {
            identity = ResolveProcess(pid);
            description = identity.Path is not null ? ResolveDescription(identity.Path) : null;

            _lastWindow = hWnd;
            _lastPid = pid;
            _lastIdentity = identity;
            _lastDescription = description;
        }

        return new ForegroundSnapshot
        {
            AppName = description ?? identity.Name,
            ProcessName = identity.Name,
            ExecutablePath = identity.Path,
            WindowTitle = title,
            WindowHandle = hWnd,
            IsBrowser = identity.Name is not null && KnownBrowsers.ContainsKey(identity.Name)
        };
    }

    /// <summary>
    /// Resolves the executable behind a process id, reading it from the kernel only when the
    /// cached entry belongs to a different process instance.
    /// </summary>
    private ProcessIdentity ResolveProcess(uint pid)
    {
        var (path, startedAt) = NativeMethods.QueryProcessIdentity(pid);

        // No handle and no start time: a protected process, or one that exited between the
        // window read and this call. A stale cache entry cannot be validated against nothing, so
        // it is not used - reporting "unknown" beats reporting the wrong application.
        if (startedAt == 0)
        {
            _logger.LogTrace("Could not identify pid {Pid}; reporting the window without an application", pid);
            return new ProcessIdentity(0, null, null);
        }

        if (_processCache.TryGetValue(pid, out var cached) && cached.StartedAtTicks == startedAt)
        {
            return cached;
        }

        var identity = new ProcessIdentity(
            startedAt,
            path,
            path is not null ? Path.GetFileNameWithoutExtension(path) : null);

        // Crude but adequate: clear the whole cache at the limit rather than tracking LRU. The
        // entries are cheap to rebuild and every one of them is re-validated on use anyway.
        if (_processCache.Count >= ProcessCacheLimit) _processCache.Clear();
        _processCache[pid] = identity;

        return identity;
    }

    /// <summary>
    /// The application's display name from its version resource, falling back to the file name.
    /// A missing or unreadable resource is normal for portable and self-built executables.
    /// </summary>
    private string? ResolveDescription(string path)
    {
        if (_descriptionCache.TryGetValue(path, out var cached)) return cached;

        string? description = null;
        try
        {
            var raw = FileVersionInfo.GetVersionInfo(path).FileDescription;
            description = string.IsNullOrWhiteSpace(raw) ? null : raw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // The executable sits on a disconnected network share, or was deleted while running.
            _logger.LogTrace(ex, "Could not read the version resource of {Path}", path);
        }

        if (_descriptionCache.Count >= DescriptionCacheLimit) _descriptionCache.Clear();
        _descriptionCache[path] = description;

        return description;
    }
}
