using System.Security.Principal;
using Agent.Core;
using Agent.Core.Contracts;
using Agent.Core.Ipc;
using Agent.Core.Policy;
using Agent.Host.Collectors;
using Agent.Host.Interop;
using Agent.Host.Ipc;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Services;

/// <summary>
/// Drives every interactive collector and turns their observations into the typed telemetry
/// events the service persists.
///
/// One loop rather than a timer per collector: attendance, activity sessions, browser visits
/// and the idle state all depend on the same "what is happening right now" reading, and
/// sampling them independently would let them disagree - an activity session recorded as
/// Application while the idle monitor already considers the user away.
///
/// HOW TIME IS MEASURED, since this is what every report about an employee is built on:
///
///   * Durations are wall-clock differences between recorded instants. Nothing is derived from
///     the tick rate, so a slow or delayed tick changes when a change is noticed, never how much
///     time is reported.
///   * A transition into or out of idle is dated from the last real input, not from the tick that
///     noticed it. Without this, every idle period would hand the whole idle threshold - five
///     minutes by default - to whichever application happened to be in focus when the user walked
///     away, and would start the idle period five minutes late.
///   * Time the agent did not observe is not invented. If a tick arrives long after the previous
///     one, the machine slept or the process was suspended, and the gap is left unattributed
///     rather than credited to whatever was last on screen.
///   * An attendance session is one uninterrupted stretch of presence, and its logout time only
///     ever moves in one direction: once stamped, the row is final. A lock, a suspend or a logoff
///     ends the session; coming back opens a new one. See <see cref="RotateAttendanceSessionAsync"/>.
///
/// AND HOW IT STAYS CHEAP: the poll interval buys boundary precision, not data, so it is left at
/// one second while the expensive collector - the browser address bar, a cross-process UI
/// Automation call - is probed only when the window it belongs to actually looks like it may have
/// navigated. See <see cref="ShouldProbeBrowser"/>.
/// </summary>
public sealed class MonitoringOrchestrator(
    HostIpcClient ipc,
    ForegroundWindowTracker foreground,
    BrowserUrlExtractor browserExtractor,
    InputCounter inputCounter,
    ScreenshotCapturer screenshots,
    SessionEventMonitor sessionEvents,
    AlertEngine alerts,
    ILogger<MonitoringOrchestrator> logger) : BackgroundService
{
    private readonly HostIpcClient _ipc = ipc;
    private readonly ForegroundWindowTracker _foreground = foreground;
    private readonly BrowserUrlExtractor _browserExtractor = browserExtractor;
    private readonly InputCounter _inputCounter = inputCounter;
    private readonly ScreenshotCapturer _screenshots = screenshots;
    private readonly SessionEventMonitor _sessionEvents = sessionEvents;
    private readonly AlertEngine _alerts = alerts;
    private readonly ILogger<MonitoringOrchestrator> _logger = logger;

    private readonly string _userSid = WindowsIdentity.GetCurrent().User?.Value ?? "S-1-0-0";

    /// <summary>
    /// The attendance session every event this host emits is grouped under.
    ///
    /// Not the Windows logon session id, and deliberately not fixed for the lifetime of the
    /// process: a lock, a suspend or a logoff ends the current attendance session, and the return
    /// to the desktop starts a new one with a new id and a new login time. Guarded by
    /// <see cref="_stateGate"/> like every other piece of session state.
    /// </summary>
    private Guid _sessionId = Guid.NewGuid();
    private DateTimeOffset _loginTime = DateTimeOffset.UtcNow;

    /// <summary>
    /// Whether the current attendance session has already had its logout time stamped.
    ///
    /// This is the invariant that keeps the attendance report honest: a stamped logout is final,
    /// so no later write may clear it or move it. Without it, the periodic refresh - which sends a
    /// null logout time to mean "still open" - overwrote the logout stamped at the preceding lock
    /// or suspend thirty seconds later, and every session the employee ever returned from ended up
    /// with a login and no logout.
    /// </summary>
    private bool _attendanceClosed;

    /// <summary>When and why the current attendance session was closed. Drives <see cref="ShouldRotateAttendance"/>.</summary>
    private DateTimeOffset _attendanceClosedAt;
    private SessionEndReason? _attendanceCloseReason;

    /// <summary>
    /// Serialises everything that touches the open segments and the running totals.
    ///
    /// Two threads reach that state: this loop, and the Windows session callbacks for lock, sleep
    /// and shutdown, which arrive whenever Windows decides to send them. Without this, a suspend
    /// landing mid-tick could close a segment the tick is still writing and double-count it.
    /// </summary>
    private readonly SemaphoreSlim _stateGate = new(1, 1);

    /// <summary>
    /// Coalesces foreground-change callbacks until the monitor consumes them. A foreground event
    /// wakes the loop immediately; ordinary polling remains the recovery path when Windows or a
    /// third-party window fails to issue an event.
    /// </summary>
    private readonly SemaphoreSlim _foregroundChanged = new(0, 1);

    private ActivitySegment? _current;
    private BrowserSegment? _currentVisit;

    private DateTimeOffset _lastTickAt;
    private DateTimeOffset _lastMetricFlush;
    private DateTimeOffset _lastScreenshot = DateTimeOffset.MinValue;
    private DateTimeOffset _lastAttendanceFlush = DateTimeOffset.MinValue;

    /// <summary>
    /// Observed working and non-working time, accumulated from closed segments rather than counted
    /// per tick, so the attendance totals and the activity log can never disagree.
    /// </summary>
    private TimeSpan _activeTime;
    private TimeSpan _idleTime;

    /// <summary>
    /// Set by the resume callback to tell the next tick that the clock ran on without us. Written
    /// from a Windows callback thread, so it is an interlocked flag rather than a timestamp: an
    /// int is written atomically, a DateTimeOffset is not.
    /// </summary>
    private int _observationBroken;

    /// <summary>
    /// Proof that the employee is back, as opposed to the tick inferring it. Both are set from
    /// Windows callback threads and both are cleared the moment an attendance session closes, so
    /// each answers exactly one question: has this arrived <em>since</em> the session ended?
    ///
    /// <see cref="_resumeSignalled"/> is an unlock, a reconnect or a power resume.
    /// <see cref="_sessionEndCancelled"/> is WM_ENDSESSION reporting that an announced logoff or
    /// shutdown was called off - the workstation is staying up and the session that was closed on
    /// the announcement has to be reopened at once rather than after a grace period.
    /// </summary>
    private int _resumeSignalled;
    private int _sessionEndCancelled;

    // -- Browser probe gating ------------------------------------------------
    private IntPtr _probedWindow = IntPtr.Zero;
    private string? _probedTitle;
    private DateTimeOffset _probedAt = DateTimeOffset.MinValue;
    private int _probeAttempts;

    /// <summary>Guards against overlapping captures when a manual request meets a scheduled one.</summary>
    private readonly SemaphoreSlim _screenshotGate = new(1, 1);

    // Policy bounds, mirrored from the backend's Zod schema (organization.dto.ts).
    //
    // The server is the enforcement point and rejects anything outside these, so a policy that
    // violates them means a hand-edited database row or a version skew - and the failure modes are
    // the ones this class exists to avoid. A zero refresh interval is a UI Automation call every
    // tick; a zero idle threshold reports a working day as entirely idle. Clamping is cheaper than
    // trusting, and a clamped value is a value the agent can still run on.
    private const int MinPollSeconds = 1;
    private const int MaxPollSeconds = 60;
    private const int MinIdleThresholdSeconds = 30;
    private const int MaxIdleThresholdSeconds = 3600;
    private const int MinUrlRefreshSeconds = 1;
    private const int MaxUrlRefreshSeconds = 300;
    private const int MinScreenshotIntervalSeconds = 60;
    private const int MaxScreenshotIntervalSeconds = 86_400;

    /// <summary>How often the activity metric window is closed and sent.</summary>
    private static readonly TimeSpan MetricFlushInterval = TimeSpan.FromMinutes(1);

    /// <summary>
    /// How often the open attendance row is refreshed.
    ///
    /// Shared with the service rather than declared here: the service decides whether a session is
    /// still alive by how long its row has gone unrefreshed, so this cadence is a contract between
    /// the two processes, not a local choice. See <see cref="AgentCadence"/>.
    /// </summary>
    private static readonly TimeSpan AttendanceFlushInterval = AgentCadence.AttendanceFlush;

    /// <summary>
    /// A tick arriving more than this multiple of the poll interval late did not measure a long
    /// stretch of user activity; it measured the agent not running. Four intervals rather than
    /// two because a workstation under load can genuinely stall a one-second loop for a moment,
    /// and misreading that as a sleep would fragment the activity log for no reason.
    /// </summary>
    private const int GapIntervalMultiple = 4;

    /// <summary>
    /// Floor for the gap threshold above. At a one-second poll, four intervals would treat any
    /// four-second hiccup as a discontinuity, which is far too eager on a busy machine.
    /// </summary>
    private static readonly TimeSpan MinimumGapThreshold = TimeSpan.FromSeconds(10);

    /// <summary>
    /// How long an announced end of the session is believed when nothing ever reports what came of
    /// it. The last resort, not the mechanism.
    ///
    /// A logoff, a shutdown and a suspend are all announced before they happen, and this loop keeps
    /// ticking in the interval between. Those ticks see a closed attendance session on an unlocked
    /// desktop, which is exactly what a returning employee looks like - and rotating there would
    /// open a new session on every single shutdown, abandon it a second later, and have it
    /// resurface as a "Recovered" row.
    ///
    /// The outcome is normally observed rather than waited out: WM_ENDSESSION says whether a
    /// logoff or shutdown actually happened, and a resume or unlock says a suspend ended. This
    /// covers only what neither reports - a suspend that was refused, or a listener window that
    /// could not be created - and the value is chosen against Win32 allowing a process seconds,
    /// not tens of seconds, to answer WM_QUERYENDSESSION or PBT_APMSUSPEND. A host still running
    /// this much later was never going anywhere.
    /// </summary>
    private static readonly TimeSpan AnnouncedEndGrace = TimeSpan.FromSeconds(30);

    /// <summary>An in-progress foreground activity session.</summary>
    private sealed class ActivitySegment
    {
        public required Guid ActivitySessionId { get; init; }
        public required ForegroundSnapshot? Snapshot { get; init; }
        public required ActivityType Type { get; init; }
        public required DateTimeOffset StartedAt { get; init; }
    }

    /// <summary>An in-progress browser visit, closed when the URL or the window changes.</summary>
    private sealed class BrowserSegment
    {
        public required Guid BrowserActivityId { get; init; }
        public required Guid ActivitySessionId { get; init; }
        public required BrowserVisit Visit { get; init; }
        public required string? WindowTitle { get; init; }
        public required DateTimeOffset StartedAt { get; init; }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _sessionEvents.SessionSuspended += OnSessionSuspended;
        _sessionEvents.SessionResumed += OnSessionResumed;
        _sessionEvents.SessionEndConfirmed += OnSessionEndConfirmed;
        _foreground.ForegroundChanged += OnForegroundChanged;

        _ipc.ScreenshotRequested += () => _ = CaptureScreenshotAsync(CancellationToken.None);

        _lastTickAt = DateTimeOffset.UtcNow;
        _lastMetricFlush = _lastTickAt;

        // Open the attendance record immediately. Features.md wants first login and last
        // logout per day, and a session that is never opened cannot be closed.
        await FlushAttendanceAsync(null, null, _lastTickAt, stoppingToken).ConfigureAwait(false);

        // Started only now, so the first callback cannot race the opening write. Subscribing
        // earlier is harmless; delivering earlier is not.
        _sessionEvents.Start();

        while (!stoppingToken.IsCancellationRequested)
        {
            var policy = _ipc.Policy;
            var interval = TimeSpan.FromSeconds(Math.Clamp(policy.AppSession.PollSeconds, MinPollSeconds, MaxPollSeconds));
            var startedAt = DateTimeOffset.UtcNow;

            try
            {
                await TickAsync(policy, interval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // One bad tick (a window that vanished mid-read, a UIA hiccup) must not stop
                // monitoring for the rest of the session.
                _logger.LogWarning(ex, "Monitoring tick failed");
            }

            // The work is subtracted from the wait rather than added to it. Delaying a full
            // interval after each tick would make the real period interval + work, which drifts
            // further from what an administrator configured the busier the machine gets.
            var remaining = interval - (DateTimeOffset.UtcNow - startedAt);
            if (remaining <= TimeSpan.Zero) continue;

            // A clock set backwards mid-tick makes the elapsed time negative and would otherwise
            // buy the wait an extra hour. The interval is the most this may ever be.
            if (remaining > interval) remaining = interval;

            try
            {
                // SetWinEventHook signals this semaphore when focus changes. A foreground
                // boundary is therefore processed promptly instead of waiting for the next poll;
                // the delay still provides recovery when an event is absent.
                using var waitCancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                var foregroundSignal = _foregroundChanged.WaitAsync(waitCancellation.Token);
                await Task.WhenAny(
                    Task.Delay(remaining, stoppingToken),
                    foregroundSignal).ConfigureAwait(false);
                waitCancellation.Cancel();
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        // Closing cleanly on shutdown is what makes the difference between an accurate logout
        // time and a "Recovered" one on the next start. Reached by breaking out of the loop
        // rather than by letting cancellation propagate - an exception here would skip it and
        // lose the end of every session.
        await ShutdownAsync().ConfigureAwait(false);
    }

    private async Task TickAsync(AgentPolicy policy, TimeSpan interval, CancellationToken ct)
    {
        await _stateGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var previousTickAt = _lastTickAt;
            _lastTickAt = now;

            // Sleep, hibernation, or a process the OS stopped scheduling. Whatever happened, the
            // time between the two ticks was not observed and must not be attributed to anyone.
            //
            // The measured gap is kept separate from the flag the session callbacks set: the flag
            // says a discontinuity was announced, the elapsed time says one actually happened, and
            // only the second is proof that the machine went away and came back.
            var gapThreshold = Max(interval * GapIntervalMultiple, MinimumGapThreshold);
            var observedGap = now - previousTickAt > gapThreshold;

            if (Interlocked.Exchange(ref _observationBroken, 0) == 1 || observedGap)
            {
                await CloseObservationGapAsync(previousTickAt, now, ct).ConfigureAwait(false);
            }

            var idleThreshold = TimeSpan.FromSeconds(
                Math.Clamp(policy.Activity.IdleThresholdSeconds, MinIdleThresholdSeconds, MaxIdleThresholdSeconds));
            var idleFor = NativeMethods.GetIdleTime();

            // The instant the user last touched the machine. This, not the tick, is when a period
            // of activity ended and a period of inactivity began.
            var lastInputAt = now - idleFor;

            // Resolve the current state. Lock beats idle: a locked screen is locked whether or not
            // the idle timer has elapsed, and reporting it as Idle would lose why the user stopped.
            var (type, snapshot) = ResolveState(policy, idleFor, idleThreshold);

            // The desktop is back after a lock, a suspend or an aborted shutdown, so the presence
            // that the closed attendance row recorded has resumed as a new one. Done before the
            // segment logic below so that everything this tick records belongs to the session that
            // is actually open.
            if (ShouldRotateAttendance(type, now, observedGap))
            {
                await RotateAttendanceSessionAsync(now, ct).ConfigureAwait(false);
            }

            // A new segment starts when the state changes, or when the focused app/title changes.
            var isSameSegment = _current is not null &&
                                _current.Type == type &&
                                (type != ActivityType.Application || (snapshot?.IsSameActivityAs(_current.Snapshot) ?? false));

            if (!isSameSegment)
            {
                var boundary = ResolveTransitionInstant(now, lastInputAt, type);
                var reason = DetermineEndReason(type);

                await CloseCurrentSegmentAsync(reason, boundary, ct).ConfigureAwait(false);

                _current = new ActivitySegment
                {
                    ActivitySessionId = Guid.NewGuid(),
                    Snapshot = snapshot,
                    Type = type,
                    // The new segment begins exactly where the old one ended, so the timeline has
                    // no gap and no overlap at a transition.
                    StartedAt = boundary
                };
            }

            if (type == ActivityType.Application && snapshot is not null)
            {
                await TrackBrowserAsync(policy, snapshot, now, ct).ConfigureAwait(false);
                await _alerts.EvaluateApplicationAsync(policy, snapshot, _userSid, ct).ConfigureAwait(false);
            }
            else
            {
                // Not looking at an application, so not looking at a browser either.
                await CloseBrowserVisitAsync(now, ct).ConfigureAwait(false);
                ResetBrowserProbe();
            }

            await _alerts.EvaluateIdleAsync(policy, idleFor, _userSid, ct).ConfigureAwait(false);

            if (now - _lastMetricFlush >= MetricFlushInterval)
            {
                await FlushMetricsAsync(now, ct).ConfigureAwait(false);
            }

            if (now - _lastAttendanceFlush >= AttendanceFlushInterval)
            {
                await FlushAttendanceAsync(null, null, now, ct).ConfigureAwait(false);
            }

            await MaybeCaptureScreenshotAsync(policy, type, now, ct).ConfigureAwait(false);
        }
        finally
        {
            _stateGate.Release();
        }
    }

    private void OnForegroundChanged()
    {
        try
        {
            _foregroundChanged.Release();
        }
        catch (SemaphoreFullException)
        {
            // Several focus changes can arrive before the monitor has processed the first one.
            // One immediate reconciliation sees the final foreground window, so extra signals add
            // no precision and must not turn a callback into an exception path.
        }
    }

    private (ActivityType Type, ForegroundSnapshot? Snapshot) ResolveState(
        AgentPolicy policy, TimeSpan idleTime, TimeSpan idleThreshold)
    {
        if (_sessionEvents.IsLocked) return (ActivityType.Locked, null);
        if (!policy.Activity.Enabled) return (ActivityType.Desktop, null);
        if (idleTime >= idleThreshold) return (ActivityType.Idle, null);

        var snapshot = _foreground.Capture();

        // No foreground window with the session unlocked and the user active means the desktop
        // itself has focus (or the secure desktop is briefly up).
        return snapshot is null
            ? (ActivityType.Desktop, null)
            : (ActivityType.Application, snapshot);
    }

    /// <summary>
    /// When a transition actually happened, as opposed to when this tick noticed it.
    ///
    /// For an ordinary application switch the two are within one poll interval and the tick is a
    /// good enough answer. Crossing the idle boundary is different: the state changed at the last
    /// keypress or click, which is by definition the idle threshold ago on the way in and a
    /// fraction of a second ago on the way out. Dating those from the tick would credit every
    /// idle period's first five minutes to the application the user walked away from.
    /// </summary>
    private DateTimeOffset ResolveTransitionInstant(DateTimeOffset now, DateTimeOffset lastInputAt, ActivityType next)
    {
        var crossesIdleBoundary = next == ActivityType.Idle || _current?.Type == ActivityType.Idle;
        if (!crossesIdleBoundary) return now;

        // Never before the segment being closed started - an application that took focus while
        // the user was already away would otherwise be given a negative duration - and never in
        // the future, which a clock adjustment between the two reads could produce.
        var floor = _current?.StartedAt ?? now;
        if (lastInputAt < floor) return floor;
        return lastInputAt > now ? now : lastInputAt;
    }

    private static ActivityEndReason DetermineEndReason(ActivityType next) => next switch
    {
        ActivityType.Idle => ActivityEndReason.UserInactivity,
        ActivityType.Locked => ActivityEndReason.ScreenLock,
        ActivityType.Sleeping => ActivityEndReason.Sleep,
        ActivityType.Disconnected => ActivityEndReason.Disconnect,
        _ => ActivityEndReason.AppSwitch
    };

    /// <summary>
    /// Ends the open segment at the last instant the agent actually observed, and leaves the
    /// unobserved stretch attributed to nobody.
    ///
    /// Crediting it would be the easy option and the wrong one: a laptop closed at lunch and
    /// opened at two would otherwise report ninety minutes of the last application in focus.
    /// </summary>
    private async Task CloseObservationGapAsync(DateTimeOffset lastObservedAt, DateTimeOffset now, CancellationToken ct)
    {
        var gap = now - lastObservedAt;

        await CloseCurrentSegmentAsync(ActivityEndReason.Sleep, lastObservedAt, ct).ConfigureAwait(false);

        // Nothing on screen can be trusted to be what was there before, and any browser visit
        // ended at the same instant.
        ResetBrowserProbe();

        // The metric window spans the gap and would report a minute of keystrokes as if they
        // happened in one window; start a fresh one.
        _inputCounter.DrainSample();
        _lastMetricFlush = now;

        _logger.LogInformation(
            "Monitoring resumed after {Gap} without observation; the interval is left unattributed",
            gap);
    }

    /// <summary>Ends the open activity session at <paramref name="endedAt"/> and records its time.</summary>
    private async Task CloseCurrentSegmentAsync(ActivityEndReason reason, DateTimeOffset endedAt, CancellationToken ct)
    {
        if (_current is null) return;

        var segment = _current;
        _current = null;

        // A browser visit cannot outlive the activity session that contains it.
        await CloseBrowserVisitAsync(endedAt, ct).ConfigureAwait(false);

        var duration = endedAt - segment.StartedAt;
        if (duration < TimeSpan.Zero) duration = TimeSpan.Zero;

        // Counted before the length test below, because the time passed whether or not it earns a
        // row. Dropping it from the totals as well would make a day of rapid window switching
        // report as less than a day.
        Accumulate(segment.Type, duration);

        // Rounded, not truncated. Truncating every segment would bias the day downwards by up to
        // a second per switch - on the order of a minute across a busy day - and always in the
        // same direction.
        var seconds = (int)Math.Round(duration.TotalSeconds, MidpointRounding.AwayFromZero);

        // Sub-second segments are noise from rapid alt-tabbing and would flood the store
        // without telling anyone anything.
        if (seconds < 1) return;

        var policy = _ipc.Policy;
        var rule = PolicyEvaluator.MatchApplication(
            policy.Categories,
            segment.Snapshot?.AppName,
            segment.Snapshot?.ProcessName,
            segment.Snapshot?.ExecutablePath);

        await _ipc.SendAsync(new SubmitActivitySessionMessage
        {
            Event = new ActivitySessionEvent
            {
                ClientEventId = Guid.NewGuid(),
                ActivitySessionId = segment.ActivitySessionId,
                SessionId = _sessionId,
                AppName = segment.Snapshot?.AppName,
                ProcessName = segment.Snapshot?.ProcessName,
                ExecutablePath = segment.Snapshot?.ExecutablePath,
                Type = segment.Type,
                WindowTitle = segment.Snapshot?.WindowTitle,
                StartTime = segment.StartedAt,
                EndTime = endedAt,
                DurationSeconds = seconds,
                Reason = reason,
                ProductivityTag = PolicyEvaluator.TagFor(rule)
            }
        }, ct).ConfigureAwait(false);
    }

    /// <summary>Working time and away time are the same clock split in two; nothing is counted twice.</summary>
    private void Accumulate(ActivityType type, TimeSpan duration)
    {
        if (type is ActivityType.Application or ActivityType.Desktop) _activeTime += duration;
        else _idleTime += duration;
    }

    // -- Browser -------------------------------------------------------------

    private async Task TrackBrowserAsync(AgentPolicy policy, ForegroundSnapshot snapshot, DateTimeOffset now, CancellationToken ct)
    {
        if (!policy.BrowserMonitor.Enabled || !snapshot.IsBrowser)
        {
            await CloseBrowserVisitAsync(now, ct).ConfigureAwait(false);
            ResetBrowserProbe();
            return;
        }

        if (!ShouldProbeBrowser(policy, snapshot, now)) return;

        _probedWindow = snapshot.WindowHandle;
        _probedTitle = snapshot.WindowTitle;
        _probedAt = now;

        var visit = await _browserExtractor
            .TryExtractAsync(snapshot, policy.BrowserMonitor.UiaTimeoutMs, policy.BrowserMonitor.MaxRetryAttempts, ct)
            .ConfigureAwait(false);

        if (visit is null)
        {
            // A window that has just changed usually answers within a tick or two while it is
            // still painting, so a miss is retried promptly - but only within the attempt budget,
            // after which it waits for the refresh interval like any unchanged window.
            _probeAttempts++;
            return;
        }

        _probeAttempts = 0;

        var isSameVisit = _currentVisit is not null &&
                          string.Equals(_currentVisit.Visit.RawUrl, visit.RawUrl, StringComparison.Ordinal);

        if (isSameVisit) return;

        await CloseBrowserVisitAsync(now, ct).ConfigureAwait(false);

        _currentVisit = new BrowserSegment
        {
            BrowserActivityId = Guid.NewGuid(),
            // Links the visit to the app session that contains it, per Features.md.
            ActivitySessionId = _current?.ActivitySessionId ?? Guid.Empty,
            Visit = visit,
            WindowTitle = snapshot.WindowTitle,
            StartedAt = now
        };

        await _alerts.EvaluateDomainAsync(policy, visit, _userSid, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether the address bar is worth reading this tick. This single decision is the difference
    /// between the agent costing a cross-process UI Automation search every second that a browser
    /// is focused, and costing one per navigation.
    ///
    /// A browser cannot navigate without changing its window title - the title is the page title -
    /// so a changed title (or a different window entirely) is the signal that the URL may have
    /// moved. The periodic refresh covers what that misses: navigation between two pages that
    /// happen to share a title, which is rare and which the refresh interval bounds.
    /// </summary>
    private bool ShouldProbeBrowser(AgentPolicy policy, ForegroundSnapshot snapshot, DateTimeOffset now)
    {
        var windowChanged =
            snapshot.WindowHandle != _probedWindow ||
            !string.Equals(snapshot.WindowTitle, _probedTitle, StringComparison.Ordinal);

        if (windowChanged)
        {
            _probeAttempts = 0;
            return true;
        }

        if (_probeAttempts > 0 && _probeAttempts <= policy.BrowserMonitor.MaxRetryAttempts) return true;

        var refreshInterval = TimeSpan.FromSeconds(
            Math.Clamp(policy.BrowserMonitor.UrlRefreshSeconds, MinUrlRefreshSeconds, MaxUrlRefreshSeconds));

        return now - _probedAt >= refreshInterval;
    }

    /// <summary>
    /// Forgets what was last probed, so that returning to a browser window reads its URL at once
    /// instead of waiting out the refresh interval. Leaving a browser and coming back to the same
    /// window and title is otherwise indistinguishable from never having left it.
    /// </summary>
    private void ResetBrowserProbe()
    {
        _probedWindow = IntPtr.Zero;
        _probedTitle = null;
        _probedAt = DateTimeOffset.MinValue;
        _probeAttempts = 0;
    }

    private async Task CloseBrowserVisitAsync(DateTimeOffset endedAt, CancellationToken ct)
    {
        if (_currentVisit is null) return;

        var visit = _currentVisit;
        _currentVisit = null;

        var duration = endedAt - visit.StartedAt;
        if (duration < TimeSpan.Zero) duration = TimeSpan.Zero;

        var seconds = (int)Math.Round(duration.TotalSeconds, MidpointRounding.AwayFromZero);
        if (seconds < 1) return;

        var rule = PolicyEvaluator.MatchDomain(_ipc.Policy.Categories, visit.Visit.Domain);

        await _ipc.SendAsync(new SubmitBrowserActivityMessage
        {
            Event = new BrowserActivityEvent
            {
                ClientEventId = Guid.NewGuid(),
                BrowserActivityId = visit.BrowserActivityId,
                ActivitySessionId = visit.ActivitySessionId == Guid.Empty ? null : visit.ActivitySessionId,
                Browser = visit.Visit.Browser,
                ProfileName = visit.Visit.ProfileName,
                Domain = visit.Visit.Domain,
                RawUrl = visit.Visit.RawUrl,
                WindowTitle = visit.WindowTitle,
                PageTitle = visit.Visit.PageTitle,
                Protocol = visit.Visit.Protocol,
                StartTime = visit.StartedAt,
                EndTime = endedAt,
                DurationSeconds = seconds,
                ProductivityTag = PolicyEvaluator.TagFor(rule)
            }
        }, ct).ConfigureAwait(false);
    }

    // -- Metrics and attendance ----------------------------------------------

    private async Task FlushMetricsAsync(DateTimeOffset now, CancellationToken ct)
    {
        var sample = _inputCounter.DrainSample();
        var windowStart = _lastMetricFlush;
        _lastMetricFlush = now;

        // A window with no input at all is not worth a row; the idle activity session already
        // records that the user was away.
        if (sample.IsEmpty) return;

        await _ipc.SendAsync(new SubmitActivityMetricMessage
        {
            Event = new ActivityMetricEvent
            {
                ClientEventId = Guid.NewGuid(),
                SessionId = _sessionId,
                KeyCount = sample.KeyCount,
                MouseCount = sample.MouseTotal,
                MouseLeftKeyCount = sample.MouseLeft,
                MouseRightKeyCount = sample.MouseRight,
                MouseMiddleKeyCount = sample.MouseMiddle,
                MouseOtherKeyCount = sample.MouseOther,
                WindowStartUtc = windowStart,
                WindowEndUtc = now
            }
        }, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Writes the attendance row. Called periodically with nulls to refresh the running
    /// totals, and with a concrete time and reason when the session actually ends.
    ///
    /// A closed session is final. Both the periodic refresh and a second closing write are dropped
    /// here rather than at the call sites, because this is the one place the row is produced and
    /// the invariant is worth enforcing where it cannot be forgotten: the store and the server both
    /// upsert on the session id, so anything written after the logout time overwrites it - a null
    /// would blank it, and a later instant would silently annex the time the employee was away.
    /// </summary>
    private async Task FlushAttendanceAsync(
        DateTimeOffset? logoutTime, SessionEndReason? reason, DateTimeOffset now, CancellationToken ct)
    {
        // Advanced even when the write below is dropped, so a closed session does not retry the
        // refresh on every tick for as long as the workstation stays locked.
        _lastAttendanceFlush = now;

        if (_attendanceClosed)
        {
            _logger.LogDebug(
                "Attendance session {SessionId} is already closed; ignoring a {Kind} write",
                _sessionId, logoutTime is null ? "refresh" : "second closing");
            return;
        }

        if (logoutTime is not null)
        {
            _attendanceClosed = true;
            _attendanceClosedAt = now;
            _attendanceCloseReason = reason;

            // Zeroed here rather than at the rotation, because these two answer "has anything since
            // *this* close proved the employee is back". A signal left over from the previous cycle
            // would answer for the wrong session and rotate immediately - which, on the tick
            // between a shutdown being announced and the machine going down, is precisely the
            // spurious row this all exists to avoid.
            Interlocked.Exchange(ref _resumeSignalled, 0);
            Interlocked.Exchange(ref _sessionEndCancelled, 0);
        }

        // The open segment counts towards the totals without being closed, so a refresh mid-way
        // through a two-hour stretch of work reports that work rather than waiting for the user
        // to switch applications.
        var active = _activeTime;
        var idle = _idleTime;

        if (_current is not null)
        {
            var open = now - _current.StartedAt;
            if (open < TimeSpan.Zero) open = TimeSpan.Zero;
            if (_current.Type is ActivityType.Application or ActivityType.Desktop) active += open;
            else idle += open;
        }

        await _ipc.SendAsync(new SubmitAttendanceMessage
        {
            Event = new AttendanceEvent
            {
                ClientEventId = Guid.NewGuid(),
                SessionId = _sessionId,
                UserSid = _userSid,
                LoginTime = _loginTime,
                LogoutTime = logoutTime,
                EndReason = reason,
                // Local date, not UTC: attendance is reported against the employee's own
                // working day, and a late shift would otherwise land on the wrong date.
                WorkDate = _loginTime.ToLocalTime().ToString("yyyy-MM-dd"),
                TotalActiveSeconds = (int)Math.Round(active.TotalSeconds, MidpointRounding.AwayFromZero),
                TotalIdleSeconds = (int)Math.Round(idle.TotalSeconds, MidpointRounding.AwayFromZero)
            }
        }, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether the employee is back at a workstation whose attendance session has already ended,
    /// which is the one condition under which a new session may be opened.
    ///
    /// The two families of end are told apart by what proves the return, because they fail in
    /// opposite directions:
    ///
    ///   * A lock or a disconnect is a state Windows reports and later reverses. The session stays
    ///     closed for exactly as long as <see cref="SessionEventMonitor.IsLocked"/> says the desktop
    ///     is unavailable, and the unlock is proof enough on its own.
    ///   * A logoff, a shutdown or a suspend is an announcement about what is *about* to happen, and
    ///     the process keeps running until it does. Returning needs real evidence, in descending
    ///     order of precision: WM_ENDSESSION reporting the end was cancelled, a resume or unlock
    ///     signalled since the close, an observed gap in the clock, or - failing all three - enough
    ///     time passing to establish that the machine never went anywhere at all.
    ///     See <see cref="AnnouncedEndGrace"/>.
    /// </summary>
    private bool ShouldRotateAttendance(ActivityType type, DateTimeOffset now, bool observedGap)
    {
        if (!_attendanceClosed) return false;

        // Locked covers the lock screen, RDP disconnection and fast user switching alike: whatever
        // ended the session, nobody is at this desktop yet.
        if (type == ActivityType.Locked) return false;

        return _attendanceCloseReason switch
        {
            SessionEndReason.Lock or SessionEndReason.Disconnect => true,
            _ => Volatile.Read(ref _sessionEndCancelled) == 1
                 || Volatile.Read(ref _resumeSignalled) == 1
                 || observedGap
                 || now - _attendanceClosedAt >= AnnouncedEndGrace
        };
    }

    /// <summary>
    /// Opens a fresh attendance session after the closed one, at the instant the desktop came back.
    ///
    /// WHY A NEW ROW RATHER THAN REOPENING THE OLD ONE. An attendance row is a stretch of presence:
    /// a login, a logout, and the working time in between. Reopening the closed row would mean
    /// clearing a logout time that has already been reported - the defect this replaces - and would
    /// leave one row claiming to span a lunch break the employee was not there for. Two rows say
    /// what actually happened, the day's first login and last logout are still the earliest and
    /// latest across them, and a row that is open is genuinely open right now.
    ///
    /// Deliberately driven by the tick and not by the resume callback: a machine woken by a wake
    /// timer or a remote wake is not an employee arriving, and it stays locked. Presence resumes
    /// when the desktop is usable again, which is what the tick observes.
    /// </summary>
    private async Task RotateAttendanceSessionAsync(DateTimeOffset now, CancellationToken ct)
    {
        // The interval the workstation spent locked or suspended belongs to the session that ended,
        // and is closed here under the outgoing session id. Its duration is deliberately dropped
        // from the totals below: the closed row's totals are presence, and the employee was away.
        await CloseCurrentSegmentAsync(ActivityEndReason.SessionEnd, now, ct).ConfigureAwait(false);

        var previous = _sessionId;

        _sessionId = Guid.NewGuid();
        _loginTime = now;
        _attendanceClosed = false;
        _attendanceCloseReason = null;

        // Per-session totals, so the new row starts at zero. RecoverOpenAttendanceSessions infers
        // an abandoned row's logout time from login plus these seconds, and carrying the previous
        // session's totals over would push that inference hours past the truth.
        _activeTime = TimeSpan.Zero;
        _idleTime = TimeSpan.Zero;

        // Metric windows are keyed on the session id too; the outgoing one was flushed when the
        // session closed, so this window starts here and starts empty. Anything the counter picked
        // up while the workstation was away belongs to the session that ended, not to this one.
        _inputCounter.DrainSample();
        _lastMetricFlush = now;

        await FlushAttendanceAsync(null, null, now, ct).ConfigureAwait(false);

        _logger.LogInformation(
            "Attendance session {Previous} ended; {SessionId} opened at {LoginTime:o}",
            previous, _sessionId, _loginTime);
    }

    // -- Screenshots ---------------------------------------------------------

    /// <summary>
    /// Captures on schedule, but only while someone is there to be captured. A locked or idle
    /// machine shows a lock screen or an untouched desktop: the capture costs a full-screen bitmap
    /// and a JPEG encode, and stores an image that answers no question the activity log has not
    /// already answered. The timer is deliberately not reset while skipping, so the first capture
    /// after the user returns happens immediately.
    /// </summary>
    private async Task MaybeCaptureScreenshotAsync(AgentPolicy policy, ActivityType type, DateTimeOffset now, CancellationToken ct)
    {
        if (!policy.Screenshot.Enabled) return;
        if (type is not (ActivityType.Application or ActivityType.Desktop)) return;

        var interval = TimeSpan.FromSeconds(
            Math.Clamp(policy.Screenshot.IntervalSeconds, MinScreenshotIntervalSeconds, MaxScreenshotIntervalSeconds));

        if (now - _lastScreenshot < interval) return;

        await CaptureScreenshotAsync(ct).ConfigureAwait(false);
    }

    private async Task CaptureScreenshotAsync(CancellationToken ct)
    {
        // A manual request from the dashboard can land while a scheduled capture is running.
        // Skipping is right: the image already being taken is the one that was asked for.
        if (!await _screenshotGate.WaitAsync(TimeSpan.Zero, ct).ConfigureAwait(false)) return;

        try
        {
            _lastScreenshot = DateTimeOffset.UtcNow;

            var shot = await Task.Run(() => _screenshots.Capture(_ipc.Policy.Screenshot.JpegQuality), ct).ConfigureAwait(false);
            if (shot is null) return;

            await _ipc.SendAsync(new SubmitScreenshotMessage
            {
                ClientEventId = shot.ClientEventId,
                UserSid = _userSid,
                CapturedAt = shot.CapturedAt,
                FilePath = shot.FilePath,
                SizeBytes = shot.SizeBytes,
                Width = shot.Width,
                Height = shot.Height
            }, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutdown during a capture. The image is not worth delaying logoff for.
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Screenshot capture failed");
        }
        finally
        {
            _screenshotGate.Release();
        }
    }

    // -- Session transitions -------------------------------------------------

    private void OnSessionSuspended(SessionEndReason reason)
    {
        // Fire-and-forget because this runs on a SystemEvents callback that Windows expects to
        // return promptly - on shutdown it has only seconds before the process is killed.
        _ = Task.Run(async () =>
        {
            var endReason = reason switch
            {
                SessionEndReason.Lock => ActivityEndReason.ScreenLock,
                SessionEndReason.Sleep => ActivityEndReason.Sleep,
                SessionEndReason.Disconnect => ActivityEndReason.Disconnect,
                _ => ActivityEndReason.SessionEnd
            };

            try
            {
                // Bounded: a tick holds the gate for milliseconds, but waiting on it without a
                // limit inside a shutdown callback would risk the process being killed mid-wait,
                // which costs the whole session's logout time rather than one segment's end
                // reason.
                if (!await _stateGate.WaitAsync(StateGateTimeout).ConfigureAwait(false))
                {
                    _logger.LogWarning("Could not close the session cleanly on {Reason}; monitoring was mid-tick", reason);
                    return;
                }
            }
            catch (ObjectDisposedException)
            {
                // The host is already tearing down and has disposed the gate. Nothing left to close.
                return;
            }

            try
            {
                var now = DateTimeOffset.UtcNow;

                // The screen locked or the machine suspended now; there is no idle threshold to
                // back-date past, so this instant is the boundary.
                await CloseCurrentSegmentAsync(endReason, now, CancellationToken.None).ConfigureAwait(false);

                // Before the attendance row closes, because the counts belong to the session that
                // is ending. The next session gets its own window; leaving them buffered would
                // either lose them here or bill them to the session the employee starts on return.
                await FlushMetricsAsync(now, CancellationToken.None).ConfigureAwait(false);

                await FlushAttendanceAsync(now, reason, now, CancellationToken.None).ConfigureAwait(false);

                // Whatever happens next - a resume hours later, or nothing at all - the stretch
                // in between was not observed.
                Interlocked.Exchange(ref _observationBroken, 1);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to close the session on {Reason}", reason);
            }
            finally
            {
                _stateGate.Release();
            }
        });
    }

    private static readonly TimeSpan StateGateTimeout = TimeSpan.FromSeconds(3);

    /// <summary>
    /// Marks the observation broken so the next tick does not bill the sleep to the last
    /// application, and records that the desktop came back. Only flags are set here: this is a
    /// Windows callback thread, and the tick owns every timestamp in this class.
    /// </summary>
    private void OnSessionResumed()
    {
        Interlocked.Exchange(ref _observationBroken, 1);
        Interlocked.Exchange(ref _resumeSignalled, 1);
    }

    /// <summary>
    /// What became of an announced logoff or shutdown.
    ///
    /// <paramref name="ending"/> false is the case worth having a window procedure for: the
    /// attendance session was closed on the announcement, the announcement was wrong, and the
    /// employee never left. The next tick reopens it - within a poll interval of the cancellation
    /// rather than at the end of a grace period spent guessing.
    /// </summary>
    private void OnSessionEndConfirmed(bool ending)
    {
        if (ending) return;
        Interlocked.Exchange(ref _sessionEndCancelled, 1);
    }

    private async Task ShutdownAsync()
    {
        if (!await _stateGate.WaitAsync(StateGateTimeout).ConfigureAwait(false))
        {
            _logger.LogWarning("Shutting down without closing the open segment; the state gate was held");
            return;
        }

        try
        {
            var now = DateTimeOffset.UtcNow;

            // CancellationToken.None throughout: the token that brought us here is already
            // cancelled, and these two writes are the difference between an accurate logout time
            // and a recovered guess on the next start.
            //
            // The attendance write is a no-op when the session was already closed by the lock or
            // suspend that preceded this shutdown - the employee stopped being present then, not
            // now, and stamping the later instant would credit them the whole locked interval.
            await CloseCurrentSegmentAsync(ActivityEndReason.SessionEnd, now, CancellationToken.None).ConfigureAwait(false);
            await FlushMetricsAsync(now, CancellationToken.None).ConfigureAwait(false);
            await FlushAttendanceAsync(now, SessionEndReason.Logout, now, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to close the session on shutdown");
        }
        finally
        {
            _stateGate.Release();
        }
    }

    private static TimeSpan Max(TimeSpan left, TimeSpan right) => left > right ? left : right;

    public override void Dispose()
    {
        _foreground.ForegroundChanged -= OnForegroundChanged;
        _sessionEvents.SessionSuspended -= OnSessionSuspended;
        _sessionEvents.SessionResumed -= OnSessionResumed;
        _sessionEvents.SessionEndConfirmed -= OnSessionEndConfirmed;
        _stateGate.Dispose();
        _foregroundChanged.Dispose();
        _screenshotGate.Dispose();
        base.Dispose();
    }
}
