namespace Agent.Collectors.AppSession;

/// <summary>
/// The full comparable identity of "what's currently in the foreground." Any field changing —
/// including WindowTitle alone (a new document, a browser tab navigation) — means a new session
/// per the spec's window-title-change edge case.
/// </summary>
public sealed record AppSessionState(AppSessionKind Kind, int ProcessId, string Executable, string WindowTitle)
{
    public static AppSessionState Application(int processId, string executable, string windowTitle) =>
        new(AppSessionKind.Application, processId, executable, windowTitle);

    public static readonly AppSessionState Desktop = new(AppSessionKind.Desktop, 0, "explorer.exe", "Desktop");
    public static readonly AppSessionState Locked = new(AppSessionKind.Locked, 0, string.Empty, "Locked");
    public static readonly AppSessionState Idle = new(AppSessionKind.Idle, 0, string.Empty, "Idle");
    public static readonly AppSessionState Sleeping = new(AppSessionKind.Sleeping, 0, string.Empty, "Sleeping");
    public static readonly AppSessionState Disconnected = new(AppSessionKind.Disconnected, 0, string.Empty, "Disconnected");
}
