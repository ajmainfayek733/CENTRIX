using Agent.Host.Interop;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Collectors;

/// <summary>
/// Features.md "Activity Level Metric" - keystroke and mouse-click counts as an activity score.
///
/// PRIVACY, and the single most important constraint in this file: this class counts events and
/// never inspects them. The keyboard callback increments a counter and returns; it does not
/// read <c>lParam</c>, does not decode the virtual key code, and has no field, buffer or log
/// statement capable of holding a typed character. Spec section 1.2 and section 6 exclude
/// keystroke content precisely so passwords and private messages are never captured, and the
/// only way to guarantee that is for the data never to be read in the first place.
///
/// Do not add key-code handling here. If a future feature seems to need it, it does not.
/// </summary>
public sealed class InputCounter : IDisposable
{
    private readonly ILogger<InputCounter> _logger;

    // The delegates are stored in fields because SetWindowsHookEx does not root its callback.
    // If these were locals the GC would collect them while Windows still held the pointer, and
    // the process would crash the first time a key was pressed.
    private readonly NativeMethods.LowLevelHookProc _keyboardProc;
    private readonly NativeMethods.LowLevelHookProc _mouseProc;

    private IntPtr _keyboardHook = IntPtr.Zero;
    private IntPtr _mouseHook = IntPtr.Zero;

    // Written from the hook callbacks (a Windows-owned thread) and read by the sampler, so
    // every counter is touched through Interlocked rather than plain reads and writes.
    private int _keyCount;
    private int _mouseLeft;
    private int _mouseRight;
    private int _mouseMiddle;
    private int _mouseOther;

    public InputCounter(ILogger<InputCounter> logger)
    {
        _logger = logger;
        _keyboardProc = KeyboardCallback;
        _mouseProc = MouseCallback;
    }

    /// <summary>
    /// Installs the hooks. Must be called from a thread with a running message pump -
    /// low-level hooks are dispatched to the installing thread's message queue, and installing
    /// them from a worker thread yields a hook that silently never fires.
    /// </summary>
    public void Start()
    {
        if (_keyboardHook != IntPtr.Zero) return;

        var module = NativeMethods.GetModuleHandleW(null);

        _keyboardHook = NativeMethods.SetWindowsHookExW(NativeMethods.WH_KEYBOARD_LL, _keyboardProc, module, 0);
        _mouseHook = NativeMethods.SetWindowsHookExW(NativeMethods.WH_MOUSE_LL, _mouseProc, module, 0);

        if (_keyboardHook == IntPtr.Zero || _mouseHook == IntPtr.Zero)
        {
            _logger.LogError("Could not install input hooks; activity level metrics will read zero");
            return;
        }

        _logger.LogInformation("Input counters started (counts only - no key content is read)");
    }

    private IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        // nCode < 0 means "pass this on without processing", per the Win32 hook contract.
        if (nCode >= 0)
        {
            var message = (int)wParam;
            if (message is NativeMethods.WM_KEYDOWN or NativeMethods.WM_SYSKEYDOWN)
            {
                // Count only. lParam holds the KBDLLHOOKSTRUCT with the virtual key code and
                // is deliberately not dereferenced.
                Interlocked.Increment(ref _keyCount);
            }
        }

        return NativeMethods.CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
    }

    private IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            switch ((int)wParam)
            {
                case NativeMethods.WM_LBUTTONDOWN:
                    Interlocked.Increment(ref _mouseLeft);
                    break;
                case NativeMethods.WM_RBUTTONDOWN:
                    Interlocked.Increment(ref _mouseRight);
                    break;
                case NativeMethods.WM_MBUTTONDOWN:
                    Interlocked.Increment(ref _mouseMiddle);
                    break;
                case NativeMethods.WM_XBUTTONDOWN:
                    Interlocked.Increment(ref _mouseOther);
                    break;
                // Mouse movement is deliberately not counted: it fires hundreds of times a
                // second and says little about engagement that clicks do not.
            }
        }

        return NativeMethods.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    public readonly record struct InputSample(
        int KeyCount,
        int MouseLeft,
        int MouseRight,
        int MouseMiddle,
        int MouseOther)
    {
        public int MouseTotal => MouseLeft + MouseRight + MouseMiddle + MouseOther;
        public bool IsEmpty => KeyCount == 0 && MouseTotal == 0;
    }

    /// <summary>
    /// Reads and zeroes every counter as one step, so input arriving during the read is
    /// attributed to the next window rather than being lost between the two.
    /// </summary>
    public InputSample DrainSample() => new(
        Interlocked.Exchange(ref _keyCount, 0),
        Interlocked.Exchange(ref _mouseLeft, 0),
        Interlocked.Exchange(ref _mouseRight, 0),
        Interlocked.Exchange(ref _mouseMiddle, 0),
        Interlocked.Exchange(ref _mouseOther, 0));

    public void Dispose()
    {
        if (_keyboardHook != IntPtr.Zero)
        {
            NativeMethods.UnhookWindowsHookEx(_keyboardHook);
            _keyboardHook = IntPtr.Zero;
        }

        if (_mouseHook != IntPtr.Zero)
        {
            NativeMethods.UnhookWindowsHookEx(_mouseHook);
            _mouseHook = IntPtr.Zero;
        }
    }
}
