using Agent.Collectors.Screenshot;

namespace Agent.Tests.Unit.Screenshot;

public class ScreenshotCaptureGateTests
{
    [Fact]
    public void DisabledByPolicy_NeverCaptures()
    {
        Assert.False(ScreenshotCaptureGate.ShouldCapture(false, false, false, false, true));
    }

    [Fact]
    public void LockedDesktop_NeverCaptures()
    {
        Assert.False(ScreenshotCaptureGate.ShouldCapture(true, isSessionLocked: true, false, false, true));
    }

    [Fact]
    public void Sleeping_NeverCaptures()
    {
        Assert.False(ScreenshotCaptureGate.ShouldCapture(true, false, isSleeping: true, false, true));
    }

    [Fact]
    public void Offline_NeverCaptures()
    {
        Assert.False(ScreenshotCaptureGate.ShouldCapture(true, false, false, isOffline: true, true));
    }

    [Fact]
    public void SecureDesktopUnavailable_NeverCaptures()
    {
        Assert.False(ScreenshotCaptureGate.ShouldCapture(true, false, false, false, isInteractiveDesktopAvailable: false));
    }

    [Fact]
    public void EnabledAndUnlockedAndAvailable_Captures()
    {
        Assert.True(ScreenshotCaptureGate.ShouldCapture(true, false, false, false, true));
    }
}
