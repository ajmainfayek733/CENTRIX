using System.Security.Principal;
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

    /// <summary>The Windows logon session this host is monitoring, for attendance and grouping.</summary>
    private readonly Guid _sessionId = Guid.NewGuid();
    private readonly DateTimeOffset _loginTime = DateTimeOffset.UtcNow;

    private ActivitySegment? _current;
    private BrowserSegment? _currentVisit;

    private DateTimeOffset _lastMetricFlush = DateTimeOffset.UtcNow;
    private DateTimeOffset _lastScreenshot = DateTimeOffset.MinValue;
    private DateTimeOffset _lastAttendanceFlush = DateTimeOffset.MinValue;

    private int _totalActiveSeconds;
    private int _totalIdleSeconds;

    /// <summary>How often the activity metric window is closed and sent.</summary>
    private static readonly TimeSpan MetricFlushInterval = TimeSpan.FromMinutes(1);

    /// <summary>
    /// How often the open attendance row is refreshed. Frequent enough that an unexpected
    /// power loss loses at most this much of the day, cheap enough not to matter - it is an
    /// upsert on one row.
    /// </summary>
    private static readonly TimeSpan AttendanceFlushInterval = TimeSpan.FromMinutes(2);

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
        _sessionEvents.Start();

        _ipc.ScreenshotRequested += () => _ = CaptureScreenshotAsync(CancellationToken.None);

        // Open the attendance record immediately. Features.md wants first login and last
        // logout per day, and a session that is never opened cannot be closed.
        await FlushAttendanceAsync(null, null, stoppingToken).ConfigureAwait(false);

        while (!stoppingToken.IsCancellationRequested)
        {
            var policy = _ipc.Policy;
            var interval = TimeSpan.FromSeconds(Math.Clamp(policy.AppSession.PollSeconds, 1, 60));

            try
            {
                await TickAsync(policy, stoppingToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // One bad tick (a window that vanished mid-read, a UIA hiccup) must not stop
                // monitoring for the rest of the session.
                _logger.LogWarning(ex, "Monitoring tick failed");
            }

            await Task.Delay(interval, stoppingToken).ConfigureAwait(false);
        }

        // Closing cleanly on shutdown is what makes the difference between an accurate logout
        // time and a "Recovered" one on the next start.
        await CloseCurrentSegmentAsync(ActivityEndReason.SessionEnd, CancellationToken.None).ConfigureAwait(false);
        await FlushAttendanceAsync(DateTimeOffset.UtcNow, SessionEndReason.Logout, CancellationToken.None).ConfigureAwait(false);
    }

    private async Task TickAsync(AgentPolicy policy, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var idleThreshold = TimeSpan.FromSeconds(policy.Activity.IdleThresholdSeconds);
        var idleTime = NativeMethods.GetIdleTime();

        // Resolve the current state. Lock beats idle: a locked screen is locked whether or not
        // the idle timer has elapsed, and reporting it as Idle would lose why the user stopped.
        var (type, snapshot) = ResolveState(policy, idleTime, idleThreshold);

        if (type == ActivityType.Application || type == ActivityType.Desktop) _totalActiveSeconds += (int)Math.Round(policy.AppSession.PollSeconds * 1.0);
        else _totalIdleSeconds += (int)Math.Round(policy.AppSession.PollSeconds * 1.0);

        // A new segment starts when the state changes, or when the focused app/title changes.
        var isSameSegment = _current is not null &&
                            _current.Type == type &&
                            (type != ActivityType.Application || (snapshot?.IsSameActivityAs(_current.Snapshot) ?? false));

        if (!isSameSegment)
        {
            var reason = DetermineEndReason(_current?.Type, type);
            await CloseCurrentSegmentAsync(reason, ct).ConfigureAwait(false);

            _current = new ActivitySegment
            {
                ActivitySessionId = Guid.NewGuid(),
                Snapshot = snapshot,
                Type = type,
                StartedAt = now
            };
        }

        if (type == ActivityType.Application && snapshot is not null)
        {
            await TrackBrowserAsync(policy, snapshot, now, ct).ConfigureAwait(false);
            await _alerts.EvaluateApplicationAsync(policy, snapshot, _userSid, ct).ConfigureAwait(false);
        }
        else if (_currentVisit is not null)
        {
            await CloseBrowserVisitAsync(now, ct).ConfigureAwait(false);
        }

        await _alerts.EvaluateIdleAsync(policy, idleTime, _userSid, ct).ConfigureAwait(false);

        if (now - _lastMetricFlush >= MetricFlushInterval) await FlushMetricsAsync(now, ct).ConfigureAwait(false);
        if (now - _lastAttendanceFlush >= AttendanceFlushInterval) await FlushAttendanceAsync(null, null, ct).ConfigureAwait(false);

        if (policy.Screenshot.Enabled &&
            now - _lastScreenshot >= TimeSpan.FromSeconds(policy.Screenshot.IntervalSeconds))
        {
            await CaptureScreenshotAsync(ct).ConfigureAwait(false);
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

    private static ActivityEndReason DetermineEndReason(ActivityType? previous, ActivityType next) => next switch
    {
        ActivityType.Idle => ActivityEndReason.UserInactivity,
        ActivityType.Locked => ActivityEndReason.ScreenLock,
        ActivityType.Sleeping => ActivityEndReason.Sleep,
        ActivityType.Disconnected => ActivityEndReason.Disconnect,
        _ => previous is null ? ActivityEndReason.AppSwitch : ActivityEndReason.AppSwitch
    };

    private async Task CloseCurrentSegmentAsync(ActivityEndReason reason, CancellationToken ct)
    {
        if (_current is null) return;

        var now = DateTimeOffset.UtcNow;
        var duration = (int)Math.Max(0, (now - _current.StartedAt).TotalSeconds);

        // Sub-second segments are noise from rapid alt-tabbing and would flood the store
        // without telling anyone anything.
        if (duration < 1)
        {
            _current = null;
            return;
        }

        await CloseBrowserVisitAsync(now, ct).ConfigureAwait(false);

        var policy = _ipc.Policy;
        var rule = PolicyEvaluator.MatchApplication(
            policy.Categories,
            _current.Snapshot?.AppName,
            _current.Snapshot?.ProcessName,
            _current.Snapshot?.ExecutablePath);

        await _ipc.SendAsync(new SubmitActivitySessionMessage
        {
            Event = new ActivitySessionEvent
            {
                ClientEventId = Guid.NewGuid(),
                ActivitySessionId = _current.ActivitySessionId,
                SessionId = _sessionId,
                AppName = _current.Snapshot?.AppName,
                ProcessName = _current.Snapshot?.ProcessName,
                ExecutablePath = _current.Snapshot?.ExecutablePath,
                Type = _current.Type,
                WindowTitle = _current.Snapshot?.WindowTitle,
                StartTime = _current.StartedAt,
                EndTime = now,
                DurationSeconds = duration,
                Reason = reason,
                ProductivityTag = PolicyEvaluator.TagFor(rule)
            }
        }, ct).ConfigureAwait(false);

        _current = null;
    }

    private async Task TrackBrowserAsync(AgentPolicy policy, ForegroundSnapshot snapshot, DateTimeOffset now, CancellationToken ct)
    {
        if (!policy.BrowserMonitor.Enabled || !snapshot.IsBrowser)
        {
            if (_currentVisit is not null) await CloseBrowserVisitAsync(now, ct).ConfigureAwait(false);
            return;
        }

        var visit = _browserExtractor.TryExtract(
            snapshot, policy.BrowserMonitor.UiaTimeoutMs, policy.BrowserMonitor.MaxRetryAttempts);

        if (visit is null) return;

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

    private async Task CloseBrowserVisitAsync(DateTimeOffset now, CancellationToken ct)
    {
        if (_currentVisit is null) return;

        var duration = (int)Math.Max(0, (now - _currentVisit.StartedAt).TotalSeconds);
        if (duration < 1)
        {
            _currentVisit = null;
            return;
        }

        var rule = PolicyEvaluator.MatchDomain(_ipc.Policy.Categories, _currentVisit.Visit.Domain);

        await _ipc.SendAsync(new SubmitBrowserActivityMessage
        {
            Event = new BrowserActivityEvent
            {
                ClientEventId = Guid.NewGuid(),
                BrowserActivityId = _currentVisit.BrowserActivityId,
                ActivitySessionId = _currentVisit.ActivitySessionId == Guid.Empty ? null : _currentVisit.ActivitySessionId,
                Browser = _currentVisit.Visit.Browser,
                ProfileName = _currentVisit.Visit.ProfileName,
                Domain = _currentVisit.Visit.Domain,
                RawUrl = _currentVisit.Visit.RawUrl,
                WindowTitle = _currentVisit.WindowTitle,
                PageTitle = _currentVisit.Visit.PageTitle,
                Protocol = _currentVisit.Visit.Protocol,
                StartTime = _currentVisit.StartedAt,
                EndTime = now,
                DurationSeconds = duration,
                ProductivityTag = PolicyEvaluator.TagFor(rule)
            }
        }, ct).ConfigureAwait(false);

        _currentVisit = null;
    }

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
    /// </summary>
    private async Task FlushAttendanceAsync(DateTimeOffset? logoutTime, SessionEndReason? reason, CancellationToken ct)
    {
        _lastAttendanceFlush = DateTimeOffset.UtcNow;

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
                TotalActiveSeconds = _totalActiveSeconds,
                TotalIdleSeconds = _totalIdleSeconds
            }
        }, ct).ConfigureAwait(false);
    }

    private async Task CaptureScreenshotAsync(CancellationToken ct)
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

            await CloseCurrentSegmentAsync(endReason, CancellationToken.None).ConfigureAwait(false);
            await FlushAttendanceAsync(DateTimeOffset.UtcNow, reason, CancellationToken.None).ConfigureAwait(false);
        });
    }

    private void OnSessionResumed() => _lastMetricFlush = DateTimeOffset.UtcNow;

    public override void Dispose()
    {
        _sessionEvents.SessionSuspended -= OnSessionSuspended;
        _sessionEvents.SessionResumed -= OnSessionResumed;
        base.Dispose();
    }
}
