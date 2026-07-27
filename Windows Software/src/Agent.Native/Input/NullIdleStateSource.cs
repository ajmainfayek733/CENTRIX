namespace Agent.Native.Input;

/// <summary>
/// Used where a real idle signal isn't available in-process — e.g. the Session-0 Windows
/// Service, where the real implementation (ActivityCollectorService) runs in the per-user tray
/// helper instead. Idle-related events for Session-0 consumers are supplied by the tray
/// helper writing directly to the shared database rather than through this interface there.
/// </summary>
public sealed class NullIdleStateSource : IIdleStateSource
{
    public event EventHandler<IdleStateChangeNotification>? IdleStateChanged
    {
        add { }
        remove { }
    }
}
