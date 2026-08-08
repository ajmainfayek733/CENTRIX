using Agent.Core.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace Agent.Host.Collectors;

/// <summary>
/// Watches for the workstation state changes Features.md calls out under "Attendace report":
/// lock/unlock, logoff, shutdown, sleep and resume.
///
/// These are what let the attendance record close correctly instead of leaving a session open
/// until the next boot, and what tell the activity log to stop counting an application as
/// "in use" when the screen is locked.
/// </summary>
public sealed class SessionEventMonitor(ILogger<SessionEventMonitor> logger) : IDisposable
{
    private readonly ILogger<SessionEventMonitor> _logger = logger;
    private bool _subscribed;

    /// <summary>Raised when the desktop becomes unavailable (lock, logoff, sleep, shutdown).</summary>
    public event Action<SessionEndReason>? SessionSuspended;

    /// <summary>Raised when the desktop becomes available again (unlock, resume, logon).</summary>
    public event Action? SessionResumed;

    public bool IsLocked { get; private set; }

    public void Start()
    {
        if (_subscribed) return;

        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
        SystemEvents.SessionEnding += OnSessionEnding;

        _subscribed = true;
        _logger.LogInformation("Session event monitor started");
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        switch (e.Reason)
        {
            case SessionSwitchReason.SessionLock:
                IsLocked = true;
                SessionSuspended?.Invoke(SessionEndReason.Lock);
                break;

            // Disconnect covers RDP and fast user switching: the session still exists but
            // nobody is looking at it, so it must not be counted as active time.
            case SessionSwitchReason.ConsoleDisconnect:
            case SessionSwitchReason.RemoteDisconnect:
                IsLocked = true;
                SessionSuspended?.Invoke(SessionEndReason.Disconnect);
                break;

            case SessionSwitchReason.SessionLogoff:
                IsLocked = true;
                SessionSuspended?.Invoke(SessionEndReason.Logout);
                break;

            case SessionSwitchReason.SessionUnlock:
            case SessionSwitchReason.ConsoleConnect:
            case SessionSwitchReason.RemoteConnect:
            case SessionSwitchReason.SessionLogon:
                IsLocked = false;
                SessionResumed?.Invoke();
                break;
        }

        _logger.LogInformation("Session switch: {Reason}", e.Reason);
    }

    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        switch (e.Mode)
        {
            case PowerModes.Suspend:
                SessionSuspended?.Invoke(SessionEndReason.Sleep);
                _logger.LogInformation("System suspending");
                break;

            case PowerModes.Resume:
                SessionResumed?.Invoke();
                _logger.LogInformation("System resumed");
                break;
        }
    }

    /// <summary>
    /// Fires on logoff and shutdown. Windows gives a process only a few seconds here before
    /// killing it, so handlers must persist the final attendance state and return — anything
    /// slower will not complete.
    /// </summary>
    private void OnSessionEnding(object sender, SessionEndingEventArgs e)
    {
        var reason = e.Reason == SessionEndReasons.SystemShutdown
            ? SessionEndReason.Shutdown
            : SessionEndReason.Logout;

        _logger.LogInformation("Session ending: {Reason}", e.Reason);
        SessionSuspended?.Invoke(reason);
    }

    public void Dispose()
    {
        if (!_subscribed) return;

        SystemEvents.SessionSwitch -= OnSessionSwitch;
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        SystemEvents.SessionEnding -= OnSessionEnding;
        _subscribed = false;
    }
}
