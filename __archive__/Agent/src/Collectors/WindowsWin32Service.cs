using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Agent.Collectors
{
    public class WindowsWin32Service : IWin32Service
    {
        [DllImport("user32.dll", EntryPoint = "GetForegroundWindow")]
        private static extern IntPtr GetForegroundWindowExternal();

        [DllImport("user32.dll", EntryPoint = "GetWindowText", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern int GetWindowTextExternal(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId", SetLastError = true)]
        private static extern uint GetWindowThreadProcessIdExternal(IntPtr hWnd, out uint lpdwProcessId);

        [StructLayout(LayoutKind.Sequential)]
        private struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll", EntryPoint = "GetLastInputInfo")]
        private static extern bool GetLastInputInfoExternal(ref LASTINPUTINFO plii);

        [DllImport("kernel32.dll", EntryPoint = "GetTickCount")]
        private static extern uint GetTickCountExternal();

        public IntPtr GetForegroundWindow()
        {
            try
            {
                return GetForegroundWindowExternal();
            }
            catch (DllNotFoundException)
            {
                return IntPtr.Zero;
            }
        }

        public string GetWindowTitle(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return string.Empty;

            try
            {
                var builder = new StringBuilder(256);
                if (GetWindowTextExternal(hWnd, builder, builder.Capacity) > 0)
                {
                    return builder.ToString();
                }
            }
            catch (DllNotFoundException)
            {
                // Fallback on non-Windows
            }
            return string.Empty;
        }

        public string GetProcessName(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return string.Empty;

            try
            {
                GetWindowThreadProcessIdExternal(hWnd, out uint processId);
                if (processId == 0) return string.Empty;

                using var process = Process.GetProcessById((int)processId);
                return process.ProcessName;
            }
            catch (DllNotFoundException)
            {
                return "Unknown";
            }
            catch (Exception)
            {
                return "Unknown";
            }
        }

        public uint GetLastInputTime()
        {
            try
            {
                var lii = new LASTINPUTINFO();
                lii.cbSize = (uint)Marshal.SizeOf(lii);
                if (GetLastInputInfoExternal(ref lii))
                {
                    return lii.dwTime;
                }
            }
            catch (DllNotFoundException)
            {
                // Fallback
            }
            return 0;
        }

        public uint GetTickCount()
        {
            try
            {
                return GetTickCountExternal();
            }
            catch (DllNotFoundException)
            {
                return 0;
            }
        }
    }
}
