using System;

namespace Agent.Collectors
{
    public interface IWin32Service
    {
        IntPtr GetForegroundWindow();
        string GetWindowTitle(IntPtr hWnd);
        string GetProcessName(IntPtr hWnd);
        uint GetLastInputTime();
        uint GetTickCount();
    }
}
