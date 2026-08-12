using Agent.Core.Contracts;
using Agent.Core.Ipc;
using Agent.Core.Policy;
using Agent.Host.Collectors;
using Agent.Host.Ipc;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Services;

/// <summary>
/// Features.md "Alert Notification": desktop notifications for prolonged idle time
/// (30 min Normal, 45 min Moderate, 60 min Severe) and an immediate High-severity warning when
/// a blacklisted application or website is opened.
///
/// The escalating idle alert reuses one client event id across all three levels, so the
/// dashboard shows a single incident that grew rather than three unrelated alerts. Blacklist
/// hits get a fresh id each time because each is a distinct access.
/// </summary>
public sealed class AlertEngine(HostIpcClient ipc, ILogger<AlertEngine> logger)
{
    private readonly HostIpcClient _ipc = ipc;
    private readonly ILogger<AlertEngine> _logger = logger;

    private Guid? _idleIncidentId;
    private int _idleEscalationLevel;
    private DateTimeOffset _idleLastNotifiedAt = DateTimeOffset.MinValue;

    /// <summary>
    /// Suppresses repeat alerts for the same app or domain. Without this, staying on a
    /// blacklisted site would raise a notification on every poll tick.
    /// </summary>
    private readonly Dictionary<string, DateTimeOffset> _recentlyAlerted = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan BlacklistRealertWindow = TimeSpan.FromMinutes(10);

    public async Task EvaluateIdleAsync(AgentPolicy policy, TimeSpan idleTime, string userSid, CancellationToken ct)
    {
        if (!policy.Alert.Enabled || !policy.Alert.Idle.Enabled)
        {
            return;
        }

        var idle = policy.Alert.Idle;
        var seconds = (int)idleTime.TotalSeconds;

        var (level, severity) = seconds switch
        {
            _ when seconds >= idle.SevereSeconds => (3, AlertSeverity.Critical),
            _ when seconds >= idle.ModerateSeconds => (2, AlertSeverity.High),
            _ when seconds >= idle.NormalSeconds => (1, AlertSeverity.Warning),
            _ => (0, AlertSeverity.Information)
        };

        if (level == 0)
        {
            // The user came back. Resolve the incident so the dashboard stops showing it open.
            if (_idleIncidentId is { } resolvedId)
            {
                await SubmitAsync(new AlertEvent
                {
                    ClientEventId = resolvedId,
                    UserSid = userSid,
                    Type = AlertType.IdleThreshold,
                    Severity = AlertSeverity.Information,
                    State = AlertState.Resolved,
                    Title = "Idle period ended",
                    Message = "Activity resumed at this workstation.",
                    IdleSeconds = seconds,
                    TriggeredAt = DateTimeOffset.UtcNow,
                    ResolvedAt = DateTimeOffset.UtcNow,
                    EscalationLevel = _idleEscalationLevel,
                    NotificationCount = _idleEscalationLevel
                }, ct).ConfigureAwait(false);

                _idleIncidentId = null;
                _idleEscalationLevel = 0;
            }
            return;
        }

        var now = DateTimeOffset.UtcNow;

        // Re-notify only when the severity actually escalates, or after the renotify interval.
        // Otherwise a user away at lunch would get a popup every polling tick.
        var isEscalation = level > _idleEscalationLevel;
        var isRenotify = now - _idleLastNotifiedAt >= TimeSpan.FromSeconds(idle.RenotifySeconds);
        if (!isEscalation && !isRenotify) return;

        _idleIncidentId ??= Guid.NewGuid();
        _idleEscalationLevel = level;
        _idleLastNotifiedAt = now;

        var threshold = level switch
        {
            3 => idle.SevereSeconds,
            2 => idle.ModerateSeconds,
            _ => idle.NormalSeconds
        };

        var minutes = threshold / 60;
        var title = $"Inactive for {minutes} minutes";
        var message = $"No keyboard or mouse activity has been detected for {minutes} minutes.";

        await SubmitAsync(new AlertEvent
        {
            ClientEventId = _idleIncidentId.Value,
            UserSid = userSid,
            Type = AlertType.IdleThreshold,
            Severity = severity,
            State = AlertState.Shown,
            Title = title,
            Message = message,
            IdleSeconds = seconds,
            ThresholdSeconds = threshold,
            TriggeredAt = now,
            LastNotifiedAt = now,
            EscalationLevel = level,
            NotificationCount = level
        }, ct).ConfigureAwait(false);

        NotifyDesktop(policy, title, message, severity);
    }

    public async Task EvaluateApplicationAsync(AgentPolicy policy, ForegroundSnapshot snapshot, string userSid, CancellationToken ct)
    {
        if (!policy.Alert.Enabled || !policy.Alert.BlacklistEnabled) return;

        var rule = PolicyEvaluator.MatchApplication(
            policy.Categories, snapshot.AppName, snapshot.ProcessName, snapshot.ExecutablePath);

        if (rule is not { IsBlacklisted: true }) return;

        var key = $"app:{snapshot.ProcessName}";
        if (!ShouldAlert(key)) return;

        var name = snapshot.AppName ?? snapshot.ProcessName ?? "An application";
        var title = "Blacklisted application";
        var message = $"{name} is not permitted under company policy. This access has been logged.";

        await SubmitAsync(new AlertEvent
        {
            ClientEventId = Guid.NewGuid(),
            UserSid = userSid,
            Type = AlertType.BlacklistedApp,
            Severity = AlertSeverity.High,
            State = AlertState.Shown,
            Title = title,
            Message = message,
            ContextAppName = snapshot.AppName,
            ContextProcessName = snapshot.ProcessName,
            TriggeredAt = DateTimeOffset.UtcNow,
            LastNotifiedAt = DateTimeOffset.UtcNow,
            NotificationCount = 1
        }, ct).ConfigureAwait(false);

        NotifyDesktop(policy, title, message, AlertSeverity.High);
    }

    public async Task EvaluateDomainAsync(AgentPolicy policy, BrowserVisit visit, string userSid, CancellationToken ct)
    {
        if (!policy.Alert.Enabled || !policy.Alert.BlacklistEnabled) return;

        var rule = PolicyEvaluator.MatchDomain(policy.Categories, visit.Domain);
        if (rule is not { IsBlacklisted: true }) return;

        var key = $"domain:{visit.Domain}";
        if (!ShouldAlert(key)) return;

        var title = "Blacklisted website";
        var message = $"{visit.Domain} is not permitted under company policy. This visit has been logged.";

        await SubmitAsync(new AlertEvent
        {
            ClientEventId = Guid.NewGuid(),
            UserSid = userSid,
            Type = AlertType.BlacklistedWebsite,
            Severity = AlertSeverity.High,
            State = AlertState.Shown,
            Title = title,
            Message = message,
            ContextDomain = visit.Domain,
            ContextUrl = visit.RawUrl,
            TriggeredAt = DateTimeOffset.UtcNow,
            LastNotifiedAt = DateTimeOffset.UtcNow,
            NotificationCount = 1
        }, ct).ConfigureAwait(false);

        NotifyDesktop(policy, title, message, AlertSeverity.High);
    }

    private bool ShouldAlert(string key)
    {
        var now = DateTimeOffset.UtcNow;

        if (_recentlyAlerted.TryGetValue(key, out var last) && now - last < BlacklistRealertWindow)
        {
            return false;
        }

        _recentlyAlerted[key] = now;

        // Keep the suppression table from growing across a long session.
        if (_recentlyAlerted.Count > 200)
        {
            var stale = _recentlyAlerted
                .Where(kvp => now - kvp.Value > BlacklistRealertWindow)
                .Select(kvp => kvp.Key)
                .ToList();

            foreach (var expired in stale) _recentlyAlerted.Remove(expired);
        }

        return true;
    }

    private async Task SubmitAsync(AlertEvent alert, CancellationToken ct)
    {
        var sent = await _ipc.SendAsync(new SubmitAlertMessage { Event = alert }, ct).ConfigureAwait(false);
        if (!sent) _logger.LogWarning("Alert {Type} could not be submitted; the service is not connected", alert.Type);
    }

    /// <summary>
    /// Raises the desktop notification. Suppressed outside working hours unless policy says
    /// otherwise - spec section 3.1 asks the agent to respect work-hours settings where feasible,
    /// and a popup at 11pm is monitoring intruding on personal time.
    /// </summary>
    private void NotifyDesktop(AgentPolicy policy, string title, string message, AlertSeverity severity)
    {
        if (!policy.Alert.NotifyOutsideWorkingHours &&
            !PolicyEvaluator.IsWithinWorkingHours(policy.WorkingHours, DateTimeOffset.Now))
        {
            _logger.LogDebug("Suppressing desktop notification outside working hours: {Title}", title);
            return;
        }

        NotificationRequested?.Invoke(new ShowNotificationMessage
        {
            Title = title,
            Message = message,
            Severity = severity
        });
    }

    /// <summary>Raised for the tray icon to display. Wired up by the application shell.</summary>
    public event Action<ShowNotificationMessage>? NotificationRequested;
}
