using System;

namespace Agent.Collectors
{
    public class SimulationWin32Service : IWin32Service
    {
        private readonly Random _random = new();
        private readonly string[] _mockApps = { "chrome", "code", "Teams", "explorer", "cmd" };
        private readonly string[] _mockTitles = { 
            "Google Chrome - Employee Dashboard", 
            "Visual Studio Code - Program.cs", 
            "Microsoft Teams - Standup Meeting", 
            "File Explorer - C:\\Projects", 
            "Command Prompt - dotnet build" 
        };

        private uint _lastInputTimeOffset;
        private uint _ticks;

        public SimulationWin32Service()
        {
            _ticks = 100000;
            _lastInputTimeOffset = 100000;
        }

        public IntPtr GetForegroundWindow()
        {
            // Return a mock window handle
            return new IntPtr(_random.Next(1, 10));
        }

        public string GetWindowTitle(IntPtr hWnd)
        {
            int index = hWnd.ToInt32() % _mockTitles.Length;
            return _mockTitles[index];
        }

        public string GetProcessName(IntPtr hWnd)
        {
            int index = hWnd.ToInt32() % _mockApps.Length;
            return _mockApps[index];
        }

        public uint GetLastInputTime()
        {
            // Simulate random user activity: 90% chance user is active (last input time is current tick count)
            // 10% chance user is idle (last input time remains unchanged while tick count increments)
            _ticks += 15000; // Increment mock ticks by 15 seconds
            
            if (_random.NextDouble() < 0.90)
            {
                _lastInputTimeOffset = _ticks;
            }
            
            return _lastInputTimeOffset;
        }

        public uint GetTickCount()
        {
            return _ticks;
        }
    }
}
