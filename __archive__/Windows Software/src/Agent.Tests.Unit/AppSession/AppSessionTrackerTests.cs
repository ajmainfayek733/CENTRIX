using Agent.Collectors.AppSession;

namespace Agent.Tests.Unit.AppSession;

public class AppSessionTrackerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void FirstObservation_OpensSessionWithoutClosingAnything()
    {
        var tracker = new AppSessionTracker();

        var transition = tracker.Observe(AppSessionState.Application(1, "chrome.exe", "Google"), T0);

        Assert.Null(transition);
        Assert.NotNull(tracker.Current);
    }

    [Fact]
    public void SameStateObservedAgain_IsNoOp()
    {
        var tracker = new AppSessionTracker();
        var chrome = AppSessionState.Application(1, "chrome.exe", "Google");
        tracker.Observe(chrome, T0);

        var transition = tracker.Observe(chrome, T0.AddSeconds(1));

        Assert.Null(transition);
        Assert.Equal(T0, tracker.Current!.Value.StartUtc);
    }

    [Fact]
    public void DifferentProcess_ClosesPreviousAndOpensNew()
    {
        var tracker = new AppSessionTracker();
        tracker.Observe(AppSessionState.Application(1, "chrome.exe", "Google"), T0);

        var transition = tracker.Observe(AppSessionState.Application(2, "devenv.exe", "Program.cs"), T0.AddMinutes(15));

        Assert.NotNull(transition);
        Assert.Equal("chrome.exe", transition!.ClosedState.Executable);
        Assert.Equal(T0, transition.StartUtc);
        Assert.Equal(T0.AddMinutes(15), transition.EndUtc);
        Assert.Equal("devenv.exe", tracker.Current!.Value.State.Executable);
    }

    [Fact]
    public void SameProcessDifferentWindowTitle_IsTreatedAsNewSession()
    {
        // MSWord Report.docx -> Budget.docx: same process, different document => new session.
        var tracker = new AppSessionTracker();
        tracker.Observe(AppSessionState.Application(1, "winword.exe", "Report.docx"), T0);

        var transition = tracker.Observe(AppSessionState.Application(1, "winword.exe", "Budget.docx"), T0.AddMinutes(5));

        Assert.NotNull(transition);
        Assert.Equal("Report.docx", transition!.ClosedState.WindowTitle);
        Assert.Equal("Budget.docx", tracker.Current!.Value.State.WindowTitle);
    }

    [Fact]
    public void BrowserTabNavigation_EachTitleChangeIsANewSession()
    {
        var tracker = new AppSessionTracker();
        tracker.Observe(AppSessionState.Application(1, "chrome.exe", "Google"), T0);
        tracker.Observe(AppSessionState.Application(1, "chrome.exe", "ChatGPT"), T0.AddMinutes(1));
        var transition = tracker.Observe(AppSessionState.Application(1, "chrome.exe", "YouTube"), T0.AddMinutes(2));

        Assert.Equal("ChatGPT", transition!.ClosedState.WindowTitle);
    }

    [Fact]
    public void LockThenUnlockToSameApp_ProducesThreeDistinctSessionsNotMerged()
    {
        var tracker = new AppSessionTracker();
        var chrome = AppSessionState.Application(1, "chrome.exe", "Google");

        tracker.Observe(chrome, T0);
        var closedChrome = tracker.Observe(AppSessionState.Locked, T0.AddMinutes(30));
        var closedLock = tracker.Observe(chrome, T0.AddMinutes(45));

        Assert.Equal(AppSessionKind.Application, closedChrome!.ClosedState.Kind);
        Assert.Equal(AppSessionKind.Locked, closedLock!.ClosedState.Kind);
        // The re-opened Chrome after unlock is a distinct (third) session, not merged with the
        // pre-lock one, even though it's the identical app/window.
        Assert.Equal(T0.AddMinutes(45), tracker.Current!.Value.StartUtc);
    }

    [Fact]
    public void IdleThenReturn_ProducesDistinctSessionsNotMerged()
    {
        var tracker = new AppSessionTracker();
        var chrome = AppSessionState.Application(1, "chrome.exe", "Google");

        tracker.Observe(chrome, T0);
        tracker.Observe(AppSessionState.Idle, T0.AddMinutes(10));
        tracker.Observe(chrome, T0.AddMinutes(30));

        Assert.Equal(T0.AddMinutes(30), tracker.Current!.Value.StartUtc);
    }

    [Fact]
    public void ProcessExit_TransitionsToDesktop()
    {
        var tracker = new AppSessionTracker();
        tracker.Observe(AppSessionState.Application(1, "notepad.exe", "Untitled - Notepad"), T0);

        var transition = tracker.Observe(AppSessionState.Desktop, T0.AddMinutes(2));

        Assert.Equal("notepad.exe", transition!.ClosedState.Executable);
        Assert.Equal(AppSessionKind.Desktop, tracker.Current!.Value.State.Kind);
    }

    [Fact]
    public void Close_ForceClosesOpenSessionWithoutOpeningANewOne()
    {
        var tracker = new AppSessionTracker();
        tracker.Observe(AppSessionState.Application(1, "chrome.exe", "Google"), T0);

        var transition = tracker.Close(T0.AddMinutes(5));

        Assert.NotNull(transition);
        Assert.Null(tracker.Current);
    }

    [Fact]
    public void Close_WithNothingOpen_ReturnsNull()
    {
        var tracker = new AppSessionTracker();

        Assert.Null(tracker.Close(T0));
    }
}
