using System.Diagnostics;
using Agent.Service.Interop;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace Agent.Service.Workers;

/// <summary>
/// Keeps exactly one <c>EmployeeMonitor.Host.exe</c> alive on the interactive desktop.
///
/// Spec section 10 requires the agent to auto-start on boot and auto-recover if it crashes.
/// The service half gets that from the Windows service manager; the host half gets it from
/// here. Supervising from the service rather than using a per-user Run key or scheduled task
/// means recovery does not depend on anything inside the user's own profile, which a user
/// could disable.
/// </summary>
public sealed class HostSupervisorWorker(
    SessionLauncher launcher,
    ILogger<HostSupervisorWorker> logger) : BackgroundService
{
    private readonly SessionLauncher _launcher = launcher;
    private readonly ILogger<HostSupervisorWorker> _logger = logger;

    private const string HostExecutableName = "EmployeeMonitor.Host.exe";

    /// <summary>How often to verify the host is still running.</summary>
    private static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Guards against a crash loop. If the host dies immediately on every launch — a missing
    /// dependency, a corrupt install — relaunching every 15 seconds forever would spam the
    /// event log and burn CPU, so repeated fast failures widen the interval.
    /// </summary>
    private static readonly TimeSpan CrashLoopBackoff = TimeSpan.FromMinutes(5);
    private const int CrashLoopThreshold = 5;

    private int _consecutiveFastExits;
    private DateTimeOffset _lastLaunchAt = DateTimeOffset.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var hostPath = ResolveHostPath();
        if (hostPath is null)
        {
            _logger.LogError(
                "{Host} was not found next to the service executable; the interactive collectors " +
                "(window, idle, input, screenshots) will not run", HostExecutableName);
            return;
        }

        // A session change (logon, logoff, fast user switch) means the previous host is gone
        // or about to be. Reacting to the event rather than only polling gets the new user's
        // host up in about a second instead of up to fifteen.
        SystemEvents.SessionSwitch += OnSessionSwitch;

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    EnsureHostRunning(hostPath);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Host supervision cycle failed");
                }

                var delay = _consecutiveFastExits >= CrashLoopThreshold ? CrashLoopBackoff : CheckInterval;
                await Task.Delay(delay, stoppingToken).ConfigureAwait(false);
            }
        }
        finally
        {
            SystemEvents.SessionSwitch -= OnSessionSwitch;
        }
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        _logger.LogInformation("Session switch: {Reason}", e.Reason);

        // A fresh logon is a fresh chance for the host to start cleanly, so clear the
        // crash-loop counter — the previous failures may have been specific to the old session.
        if (e.Reason is SessionSwitchReason.SessionLogon or SessionSwitchReason.ConsoleConnect)
        {
            _consecutiveFastExits = 0;
        }
    }

    private void EnsureHostRunning(string hostPath)
    {
        if (IsHostRunning()) return;

        // Distinguish "died immediately" from "ran for a while then exited". Only the former
        // indicates a broken install worth backing off from.
        var ranBriefly = _lastLaunchAt != DateTimeOffset.MinValue &&
                         DateTimeOffset.UtcNow - _lastLaunchAt < TimeSpan.FromSeconds(30);

        if (ranBriefly)
        {
            _consecutiveFastExits++;
            if (_consecutiveFastExits == CrashLoopThreshold)
            {
                _logger.LogError(
                    "{Host} has exited immediately {Count} times in a row; backing off to {Backoff} between attempts",
                    HostExecutableName, _consecutiveFastExits, CrashLoopBackoff);
            }
        }
        else
        {
            _consecutiveFastExits = 0;
        }

        var pid = _launcher.LaunchInActiveSession(hostPath);
        if (pid.HasValue) _lastLaunchAt = DateTimeOffset.UtcNow;
    }

    /// <summary>
    /// Checks by process name rather than by remembering a pid: the host can also be started
    /// by the shell during development, and a stale pid would make us launch a duplicate.
    /// </summary>
    private static bool IsHostRunning()
    {
        var name = Path.GetFileNameWithoutExtension(HostExecutableName);
        var processes = Process.GetProcessesByName(name);

        try
        {
            return processes.Length > 0;
        }
        finally
        {
            foreach (var process in processes) process.Dispose();
        }
    }

    private static string? ResolveHostPath()
    {
        var directory = AppContext.BaseDirectory;
        var candidate = Path.Combine(directory, HostExecutableName);
        return File.Exists(candidate) ? candidate : null;
    }
}
