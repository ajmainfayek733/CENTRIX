using System.Diagnostics;
using System.Runtime.Versioning;
using Agent.Native.Sessions;
using Microsoft.Win32;

namespace Agent.Native;

/// <summary>
/// The interactive-process equivalent of the ServiceBase session/power bridge used by the
/// Session-0 service: a normal desktop app can't receive SERVICE_CONTROL_SESSIONCHANGE, but
/// Microsoft.Win32.SystemEvents.SessionSwitch/PowerModeChanged are the documented, standard way
/// to get the same notifications in a process with a message pump (which a WinForms app
/// provides automatically). Requires a running message loop (Application.Run).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SystemEventsSessionAndPowerBridge : ISessionEventSource, IPowerEventSource, IDisposable
{
    public SystemEventsSessionAndPowerBridge()
    {
        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
    }

    public event EventHandler<SessionChangeNotification>? SessionChanged;

    public event EventHandler<PowerChangeNotification>? PowerChanged;

    public void Dispose()
    {
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
    }

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        var reason = MapReason(e.Reason);
        if (reason is { } mapped)
        {
            // SessionSwitchEventArgs carries no session ID; the tray helper only ever cares
            // about its own session, so that's what belongs here — not a process ID.
            var sessionId = Process.GetCurrentProcess().SessionId;
            SessionChanged?.Invoke(this, new SessionChangeNotification(mapped, sessionId, DateTimeOffset.UtcNow));
        }
    }

    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        var kind = e.Mode switch
        {
            PowerModes.Suspend => PowerChangeKind.Suspend,
            PowerModes.Resume => PowerChangeKind.ResumeAutomatic,
            PowerModes.StatusChange => PowerChangeKind.PowerStatusChange,
            _ => (PowerChangeKind?)null
        };

        if (kind is { } mapped)
        {
            PowerChanged?.Invoke(this, new PowerChangeNotification(mapped, DateTimeOffset.UtcNow));
        }
    }

    private static SessionChangeReasonKind? MapReason(SessionSwitchReason reason) => reason switch
    {
        SessionSwitchReason.ConsoleConnect => SessionChangeReasonKind.ConsoleConnect,
        SessionSwitchReason.ConsoleDisconnect => SessionChangeReasonKind.ConsoleDisconnect,
        SessionSwitchReason.RemoteConnect => SessionChangeReasonKind.RemoteConnect,
        SessionSwitchReason.RemoteDisconnect => SessionChangeReasonKind.RemoteDisconnect,
        SessionSwitchReason.SessionLogon => SessionChangeReasonKind.SessionLogon,
        SessionSwitchReason.SessionLogoff => SessionChangeReasonKind.SessionLogoff,
        SessionSwitchReason.SessionLock => SessionChangeReasonKind.SessionLock,
        SessionSwitchReason.SessionUnlock => SessionChangeReasonKind.SessionUnlock,
        SessionSwitchReason.SessionRemoteControl => SessionChangeReasonKind.SessionRemoteControl,
        _ => null
    };
}
