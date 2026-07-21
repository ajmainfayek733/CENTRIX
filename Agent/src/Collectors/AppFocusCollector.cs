using System;
using System.Threading;
using System.Threading.Tasks;
using Agent.Core;

namespace Agent.Collectors
{
    public class AppFocusCollector : IActivityCollector
    {
        private readonly IWin32Service _win32Service;

        public AppFocusCollector(IWin32Service win32Service)
        {
            _win32Service = win32Service ?? throw new ArgumentNullException(nameof(win32Service));
        }

        public Task<(string? AppName, string? WindowTitle)> GetActiveWindowAsync(CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            
            IntPtr hWnd = _win32Service.GetForegroundWindow();
            if (hWnd == IntPtr.Zero)
            {
                return Task.FromResult<(string?, string?)>((null, null));
            }

            string processName = _win32Service.GetProcessName(hWnd);
            string windowTitle = _win32Service.GetWindowTitle(hWnd);

            return Task.FromResult<(string?, string?)>((processName, windowTitle));
        }
    }
}
