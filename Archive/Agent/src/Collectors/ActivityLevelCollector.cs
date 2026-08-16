using System;
using System.Threading;
using System.Threading.Tasks;
using Agent.Core;

namespace Agent.Collectors
{
    /// <summary>
    /// Tracks aggregate activity counts (keystrokes and mouse movements)
    /// without keylogging actual keys.
    /// Principal Engineer Note: Standard Windows Services run in Session 0, 
    /// which prevents the use of low-level hooks (WH_KEYBOARD_LL/WH_MOUSE_LL) 
    /// without a separate helper process in the user session. 
    /// To bypass this safely and efficiently, we poll GetLastInputTime (via IWin32Service)
    /// at a short interval (e.g., 200ms) to detect state changes.
    /// </summary>
    public class ActivityLevelCollector : IActivityLevelDetector, IDisposable
    {
        private readonly IWin32Service _win32Service;
        private int _activityCount;
        private uint _lastObservedInputTime;
        private Timer? _pollingTimer;
        private readonly object _lock = new();
        private bool _isListening;

        public ActivityLevelCollector(IWin32Service win32Service)
        {
            _win32Service = win32Service ?? throw new ArgumentNullException(nameof(win32Service));
        }

        public void StartListening()
        {
            lock (_lock)
            {
                if (_isListening) return;
                
                _activityCount = 0;
                _lastObservedInputTime = _win32Service.GetLastInputTime();
                
                // Poll every 200ms to detect keystroke or mouse movement changes.
                _pollingTimer = new Timer(PollActivity, null, TimeSpan.Zero, TimeSpan.FromMilliseconds(200));
                _isListening = true;
            }
        }

        public void StopListening()
        {
            lock (_lock)
            {
                if (!_isListening) return;
                
                _pollingTimer?.Change(Timeout.Infinite, Timeout.Infinite);
                _pollingTimer?.Dispose();
                _pollingTimer = null;
                _isListening = false;
            }
        }

        public int GetAndResetActivityCount()
        {
            lock (_lock)
            {
                int count = _activityCount;
                _activityCount = 0;
                return count;
            }
        }

        private void PollActivity(object? state)
        {
            try
            {
                uint currentInputTime = _win32Service.GetLastInputTime();
                
                lock (_lock)
                {
                    if (currentInputTime != _lastObservedInputTime)
                    {
                        // Input occurred! Increment score.
                        _activityCount++;
                        _lastObservedInputTime = currentInputTime;
                    }
                }
            }
            catch
            {
                // Suppress exceptions in polling timer to prevent crash
            }
        }

        public void Dispose()
        {
            StopListening();
            GC.SuppressFinalize(this);
        }
    }
}
