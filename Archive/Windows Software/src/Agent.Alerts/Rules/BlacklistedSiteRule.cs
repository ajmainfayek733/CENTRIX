using System.Text.Json;
using Agent.Collectors.Browser;
using Agent.Core.Policy;

namespace Agent.Alerts.Rules;

public sealed class BlacklistedSiteRule : IAlertRule<BrowserNavigationEvent>
{
    public bool ShouldEvaluate(BrowserNavigationEvent telemetryEvent) => telemetryEvent.Domain is not null;

    public Task<AlertEvaluationResult?> EvaluateAsync(BrowserNavigationEvent telemetryEvent, PolicyDocument policy, CancellationToken cancellationToken)
    {
        var blacklist = policy.Alert.Blacklist;
        if (!policy.Alert.Enabled || !blacklist.Enabled || telemetryEvent.Domain is null)
        {
            return Task.FromResult<AlertEvaluationResult?>(null);
        }

        if (!blacklist.DomainPatterns.Any(pattern => MatchesWildcard(telemetryEvent.Domain, pattern)))
        {
            return Task.FromResult<AlertEvaluationResult?>(null);
        }

        var context = JsonSerializer.Serialize(new
        {
            Domain = telemetryEvent.Domain,
            FullUrl = telemetryEvent.NormalizedUrl ?? telemetryEvent.RawUrl,
            Browser = telemetryEvent.Browser.ToString()
        });

        return Task.FromResult<AlertEvaluationResult?>(new AlertEvaluationResult(
            AlertType.BlacklistedWebsite,
            AlertSeverity.High,
            "Restricted Website Accessed",
            $"Access to {telemetryEvent.Domain} is restricted by company policy.",
            context));
    }

    /// <summary>Supports "*.facebook.com" matching both subdomains (m.facebook.com) and the
    /// bare domain (facebook.com) itself, per the spec's own URL-matching examples.</summary>
    private static bool MatchesWildcard(string domain, string pattern)
    {
        if (pattern.StartsWith("*.", StringComparison.Ordinal))
        {
            var suffixWithDot = pattern[1..];
            var bareDomain = suffixWithDot[1..];
            return domain.EndsWith(suffixWithDot, StringComparison.OrdinalIgnoreCase)
                || domain.Equals(bareDomain, StringComparison.OrdinalIgnoreCase);
        }

        return domain.Equals(pattern, StringComparison.OrdinalIgnoreCase);
    }
}
