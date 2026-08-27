using System.Windows.Interop;
using System.Windows.Threading;
using Agent.Core.Contracts;
using Agent.Host.Interop;
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
///
/// Lock, unlock and power transitions come from <see cref="SystemEvents"/>, which is a thin
/// managed wrapper over the same session notifications and WM_POWERBROADCAST this would otherwise
/// register for by hand.
///
/// THE END OF A SESSION IS READ OFF THE WINDOW PROCEDURE INSTEAD, because the managed surface
/// cannot express it. Windows announces a logoff or shutdown with WM_QUERYENDSESSION and then
/// reports the outcome with WM_ENDSESSION, whose wParam is FALSE when the end was called off -
/// another application refused it, or the user did. SystemEvents raises the announcement
/// (SessionEnding) and the confirmation (SessionEnded) but has no event for the cancellation, so
/// an agent built on it can only guess, and a guess here is an attendance session left closed
/// while the employee carries on working. It also cannot tell a genuine logoff from the Restart
/// Manager closing the agent to service it - lParam can, and the two mean opposite things.
///
/// ONE LIMIT WORTH KNOWING, because it decides how far the cancellation signal can be trusted.
/// WPF answers WM_QUERYENDSESSION on its own window too, raises
/// <c>Application.SessionEnding</c>, and - documented behaviour - calls <c>Shutdown()</c> whenever
/// that event is not cancelled. Cancelling it is the only way to stop that, and cancelling also
/// tells Windows to abandon the shutdown, which monitoring software has no business doing. So the
/// host is on its way out from the moment the query arrives, and WM_ENDSESSION(FALSE) is reported
/// only when it arrives before the dispatcher gets to that shutdown. When it does not, the
/// supervising service relaunches the host within its check interval and a new attendance session
/// opens there instead. Either way the record is right; this only decides whether the gap is
/// milliseconds or seconds.
/// </summary>
public sealed class SessionEventMonitor(ILogger<SessionEventMonitor> logger) : IDisposable
{
    private readonly ILogger<SessionEventMonitor> _logger = logger;
    private bool _subscribed;

    /// <summary>
    /// The hidden window whose procedure the session-end messages are read from.
    ///
    /// A real top-level window, not a message-only one: WM_QUERYENDSESSION is broadcast to
    /// top-level windows, and a HWND_MESSAGE window would never receive it.
    /// </summary>
    private HwndSource? _listener;
    private Dispatcher? _dispatcher;

    /// <summary>
    /// Whether a WM_QUERYENDSESSION this monitor treated as a real session end is still awaiting
    /// its WM_ENDSESSION. Guards against reporting an outcome for an announcement that was never
    /// made - a Restart Manager close is skipped on the way in, and its confirmation must be
    /// skipped on the way out too. Touched only from the UI thread, where both messages arrive.
    /// </summary>
    private bool _endAnnounced;

    /// <summary>Raised when the desktop becomes unavailable (lock, logoff, sleep, shutdown).</summary>
    public event Action<SessionEndReason>? SessionSuspended;

    /// <summary>Raised when the desktop becomes available again (unlock, resume, logon).</summary>
    public event Action? SessionResumed;

    /// <summary>
    /// The outcome of an announced logoff or shutdown: <c>true</c> if the session really is ending,
    /// <c>false</c> if it was called off and the employee is still at their desk.
    /// </summary>
    public event Action<bool>? SessionEndConfirmed;

    public bool IsLocked { get; private set; }

    public void Start()
    {
        if (_subscribed) return;

        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;

        // Only one of the two may be live, or a logoff would be reported twice with two different
        // reasons and the first one to arrive - which is not defined - would win.
        if (!TryStartSessionEndListener())
        {
            SystemEvents.SessionEnding += OnSessionEnding;
            _logger.LogWarning(
                "Falling back to SystemEvents.SessionEnding; a cancelled shutdown will be inferred " +
                "from the tick rather than observed");
        }

        _subscribed = true;
        _logger.LogInformation("Session event monitor started");
    }

    /// <summary>
    /// Creates the listener window on the UI thread.
    ///
    /// It has to be that thread specifically: a window belongs to the thread that created it and
    /// only receives messages while that thread pumps them, and the UI thread is the only one here
    /// that does. A window created on a worker would be silently deaf, which is the failure mode
    /// this whole class exists to avoid.
    /// </summary>
    private bool TryStartSessionEndListener()
    {
        _dispatcher = System.Windows.Application.Current?.Dispatcher;
        if (_dispatcher is null)
        {
            _logger.LogWarning("No WPF dispatcher; the session-end listener cannot be created");
            return false;
        }

        try
        {
            _dispatcher.Invoke(() =>
            {
                var parameters = new HwndSourceParameters("EmployeeMonitor.SessionEndListener")
                {
                    // Zero-sized, never shown, and kept out of the taskbar and alt-tab list. It
                    // exists to have a window procedure, not to be looked at.
                    Width = 0,
                    Height = 0,
                    WindowStyle = 0,
                    ExtendedWindowStyle = NativeMethods.WS_EX_TOOLWINDOW,
                    ParentWindow = IntPtr.Zero
                };

                _listener = new HwndSource(parameters);
                _listener.AddHook(OnWindowMessage);
            });

            _logger.LogInformation("Session-end listener window created");
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not create the session-end listener window");
            return false;
        }
    }

    /// <summary>
    /// The window procedure hook. Runs on the UI thread.
    ///
    /// Neither message is marked handled: Win32 documents DefWindowProc as returning TRUE for
    /// WM_QUERYENDSESSION, which is the answer this agent must always give. Monitoring software
    /// does not get to veto an employee's shutdown, and refusing one would also hang the machine
    /// behind a "this app is preventing shutdown" screen with the agent named on it.
    /// </summary>
    private IntPtr OnWindowMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        switch (msg)
        {
            case NativeMethods.WM_QUERYENDSESSION:
                OnQueryEndSession(EndSessionFlags(lParam));
                break;

            case NativeMethods.WM_ENDSESSION:
                OnEndSession(wParam != IntPtr.Zero);
                break;
        }

        return IntPtr.Zero;
    }

    /// <summary>
    /// The low 32 bits of lParam, which carry the ENDSESSION_* bits on both messages.
    /// </summary>
    private static uint EndSessionFlags(IntPtr lParam) => unchecked((uint)lParam.ToInt64());

    /// <summary>
    /// Windows is asking whether the session may end. The answer is always yes; this is where the
    /// attendance session is closed, because the process may be killed as soon as every
    /// application has answered and a logout time written after that is a logout time lost.
    ///
    /// Win32 recommends deferring cleanup to WM_ENDSESSION, and that recommendation is written for
    /// applications that save documents. Persisting here costs one pipe write, and the outcome
    /// message is what corrects the record if the shutdown turns out to have been called off.
    /// </summary>
    private void OnQueryEndSession(uint flags)
    {
        // The Restart Manager closing the agent to replace a file it holds - an upgrade, or
        // servicing. The process is going away and the employee is not: reporting it as a logoff
        // would put a spurious end to their working day, and the ordinary host-exit path already
        // closes the session at the last instant actually observed.
        if ((flags & NativeMethods.ENDSESSION_CLOSEAPP) != 0)
        {
            _logger.LogInformation("Restart Manager is closing the host; not treated as a session end");
            return;
        }

        // A bit mask, so tested bitwise rather than for equality. Zero means shutdown or restart,
        // and Win32 is explicit that the two cannot be told apart.
        var reason = (flags & NativeMethods.ENDSESSION_LOGOFF) != 0
            ? SessionEndReason.Logout
            : SessionEndReason.Shutdown;

        _endAnnounced = true;

        _logger.LogInformation(
            "Session end announced: {Reason}{Forced}",
            reason,
            (flags & NativeMethods.ENDSESSION_CRITICAL) != 0 ? " (forced)" : string.Empty);

        SessionSuspended?.Invoke(reason);
    }

    /// <summary>
    /// The outcome. <paramref name="ending"/> is false when the logoff or shutdown was called off,
    /// which is the case no managed event reports and the reason this window exists: the
    /// attendance session was closed a moment ago on an announcement that turned out to be wrong,
    /// and the employee is still sitting there.
    /// </summary>
    private void OnEndSession(bool ending)
    {
        if (!_endAnnounced) return;
        _endAnnounced = false;

        _logger.LogInformation(
            ending ? "Session end confirmed" : "Session end cancelled; the workstation is staying up");

        SessionEndConfirmed?.Invoke(ending);
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
    /// The fallback path, used only when the listener window could not be created. Fires on logoff
    /// and shutdown. Windows gives a process only a few seconds here before killing it, so handlers
    /// must persist the final attendance state and return - anything slower will not complete.
    ///
    /// It cannot report the outcome, only the announcement, so a cancelled shutdown falls back to
    /// being inferred from how long the host keeps running afterwards.
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

        // The window belongs to the UI thread and may only be torn down there. Disposing the
        // HwndSource destroys it; the hook goes with it, but is removed first so a message
        // arriving mid-teardown cannot reach a half-disposed monitor.
        var listener = _listener;
        _listener = null;

        if (listener is not null)
        {
            try
            {
                _dispatcher?.Invoke(() =>
                {
                    listener.RemoveHook(OnWindowMessage);
                    listener.Dispose();
                });
            }
            catch (Exception ex)
            {
                // Shutdown is exactly when this runs, and a dispatcher that has already stopped is
                // not a failure worth propagating out of Dispose - the window dies with the process.
                _logger.LogDebug(ex, "Could not dispose the session-end listener window");
            }
        }

        _subscribed = false;
    }
}
