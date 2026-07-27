namespace Agent.Native;

public sealed record ForegroundWindowSnapshot(nint WindowHandle, int ProcessId, string ExecutablePath, string WindowTitle);

public interface IForegroundWindowMonitor
{
    /// <summary>
    /// Null when there is no foreground window, the process could not be opened (elevation
    /// mismatch), or the window belongs to the secure desktop (UAC prompt).
    /// </summary>
    ForegroundWindowSnapshot? GetCurrentForegroundWindow();
}
