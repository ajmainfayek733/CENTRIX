namespace Agent.Native.Sessions;

public enum SessionChangeReasonKind
{
    ConsoleConnect,
    ConsoleDisconnect,
    RemoteConnect,
    RemoteDisconnect,
    SessionLogon,
    SessionLogoff,
    SessionLock,
    SessionUnlock,
    SessionRemoteControl,
    SessionCreate,
    SessionTerminate
}

public sealed record SessionChangeNotification(SessionChangeReasonKind Reason, int SessionId, DateTimeOffset OccurredAtUtc);

/// <summary>
/// Published by the ServiceBase-derived host (the only place SCM delivers
/// SERVICE_CONTROL_SESSIONCHANGE) and consumed by any collector that cares about session state,
/// decoupling collectors from System.ServiceProcess entirely.
/// </summary>
public interface ISessionEventSource
{
    event EventHandler<SessionChangeNotification>? SessionChanged;
}

public sealed class SessionEventPublisher : ISessionEventSource
{
    public event EventHandler<SessionChangeNotification>? SessionChanged;

    public void Publish(SessionChangeNotification notification) =>
        SessionChanged?.Invoke(this, notification);
}
