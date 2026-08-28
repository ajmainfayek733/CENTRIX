namespace Agent.Collectors.Screenshot;

/// <summary>
/// Pure gating logic, deliberately separated from the actual GDI capture so it's unit-testable
/// without a real display. Covers the spec's "Locked desktop (expected failure)" and related
/// reliability cases.
/// </summary>
public static class ScreenshotCaptureGate
{
    public static bool ShouldCapture(
        bool policyEnabled,
        bool isSessionLocked,
        bool isSleeping,
        bool isOffline,
        bool isInteractiveDesktopAvailable) =>
        policyEnabled && !isSessionLocked && !isSleeping && !isOffline && isInteractiveDesktopAvailable;
}
