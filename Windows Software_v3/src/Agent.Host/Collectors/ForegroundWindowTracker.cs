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
    /// Executable path lookups hit the process table and are comparatively slow, so results
    /// are cached per pid. Bounded because a long-running session can churn through many.
    /// </summary>
    private readonly Dictionary<uint, (string? Path, string? Description)> _processCache = new();
    private const int ProcessCacheLimit = 256;

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
        var (executablePath, description) = ResolveProcess(pid);

        var processName = executablePath is not null
            ? Path.GetFileNameWithoutExtension(executablePath)
            : null;

        return new ForegroundSnapshot
        {
            AppName = description ?? processName,
            ProcessName = processName,
            ExecutablePath = executablePath,
            WindowTitle = title,
            WindowHandle = hWnd,
            IsBrowser = processName is not null && KnownBrowsers.ContainsKey(processName)
        };
    }

    private (string? Path, string? Description) ResolveProcess(uint pid)
    {
        if (_processCache.TryGetValue(pid, out var cached)) return cached;

        (string? Path, string? Description) result;
        try
        {
            using var process = Process.GetProcessById((int)pid);

            // MainModule throws for protected and cross-bitness processes - a standard-user
            // agent cannot read an elevated process's modules. That is expected, not an error:
            // we fall back to the process name and keep going.
            var path = process.MainModule?.FileName;
            var description = path is not null
                ? FileVersionInfo.GetVersionInfo(path).FileDescription
                : null;

            result = (path, string.IsNullOrWhiteSpace(description) ? null : description);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or ArgumentException)
        {
            _logger.LogTrace(ex, "Could not resolve module path for pid {Pid}", pid);
            result = (null, null);
        }

        // Crude but adequate: clear the whole cache at the limit rather than tracking LRU.
        // Pids are only reused after a wrap, and a stale entry would attribute time to the
        // wrong application.
        if (_processCache.Count >= ProcessCacheLimit) _processCache.Clear();
        _processCache[pid] = result;

        return result;
    }
}
