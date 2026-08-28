using Agent.Core.Contracts;

namespace Agent.Core.Policy;

/// <summary>
/// Applies the admin's category rules locally. The backend re-derives the same tags at ingest
/// and its answer wins for reporting; this exists so the agent can raise a blacklist
/// notification on the desktop immediately, without a round trip.
/// </summary>
public static class PolicyEvaluator
{
    /// <summary>
    /// Matches an application against the rules. Checks app name, process name and executable
    /// path so a single rule of "chrome" catches all three spellings.
    ///
    /// A blacklist match wins outright: it returns immediately rather than being overridden by
    /// a later Productive rule for the same app.
    /// </summary>
    public static CategoryRule? MatchApplication(
        IReadOnlyList<CategoryRule> rules,
        string? appName,
        string? processName,
        string? executablePath)
    {
        Span<string?> candidates = [appName, processName, executablePath];
        CategoryRule? firstMatch = null;

        foreach (var rule in rules)
        {
            if (rule.Target != CategoryTarget.Application) continue;

            var pattern = rule.Pattern;
            var matched = false;
            foreach (var candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate) &&
                    candidate.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                {
                    matched = true;
                    break;
                }
            }

            if (!matched) continue;
            if (rule.IsBlacklisted) return rule;
            firstMatch ??= rule;
        }

        return firstMatch;
    }

    /// <summary>
    /// Matches a host against the domain rules. Suffix-matched, so "facebook.com" also covers
    /// "m.facebook.com" while "notfacebook.com" stays unmatched.
    /// </summary>
    public static CategoryRule? MatchDomain(IReadOnlyList<CategoryRule> rules, string? domain)
    {
        if (string.IsNullOrWhiteSpace(domain)) return null;

        CategoryRule? firstMatch = null;
        foreach (var rule in rules)
        {
            if (rule.Target != CategoryTarget.Domain) continue;

            var isMatch =
                domain.Equals(rule.Pattern, StringComparison.OrdinalIgnoreCase) ||
                domain.EndsWith("." + rule.Pattern, StringComparison.OrdinalIgnoreCase);

            if (!isMatch) continue;
            if (rule.IsBlacklisted) return rule;
            firstMatch ??= rule;
        }

        return firstMatch;
    }

    public static ProductivityTag TagFor(CategoryRule? rule) =>
        rule is null ? ProductivityTag.Neutral
        : rule.IsBlacklisted ? ProductivityTag.Blacklisted
        : rule.Tag;

    /// <summary>
    /// Whether <paramref name="localTime"/> falls inside configured working hours. Used to
    /// suppress desktop alerts out of hours (spec section 3.1: "no monitoring outside work
    /// context ... where feasible") unless the policy says otherwise.
    /// </summary>
    public static bool IsWithinWorkingHours(WorkingHoursPolicy policy, DateTimeOffset localTime)
    {
        var dayName = localTime.DayOfWeek.ToString();
        if (!policy.WorkingDays.Contains(dayName, StringComparer.OrdinalIgnoreCase)) return false;

        if (!TimeOnly.TryParse(policy.StartLocal, out var start)) start = new TimeOnly(8, 0);
        if (!TimeOnly.TryParse(policy.EndLocal, out var end)) end = new TimeOnly(17, 0);

        var now = TimeOnly.FromDateTime(localTime.LocalDateTime);

        // An end earlier than the start means the shift crosses midnight (e.g. 22:00-06:00).
        return start <= end
            ? now >= start && now <= end
            : now >= start || now <= end;
    }
}
