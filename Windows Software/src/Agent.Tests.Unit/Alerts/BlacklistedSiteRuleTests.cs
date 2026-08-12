using Agent.Alerts;
using Agent.Alerts.Rules;
using Agent.Collectors.Browser;
using Agent.Core.Policy;

namespace Agent.Tests.Unit.Alerts;

public class BlacklistedSiteRuleTests
{
    private readonly BlacklistedSiteRule _rule = new();

    private static BrowserNavigationEvent Navigation(string domain) => new()
    {
        ClientEventId = Guid.NewGuid(),
        MachineId = "machine-1",
        UserSid = "S-1-5-21-user",
        Browser = BrowserType.Chrome,
        RawUrl = $"https://{domain}/",
        NormalizedUrl = $"https://{domain}/",
        Domain = domain,
        Category = UrlSchemeCategory.Https,
        OccurredAtUtc = DateTimeOffset.UtcNow
    };

    private static PolicyDocument PolicyWith(params string[] patterns) => new()
    {
        Version = 1,
        Alert = new AlertPolicy { Blacklist = new BlacklistPolicy { Enabled = true, DomainPatterns = patterns } }
    };

    [Theory]
    [InlineData("m.facebook.com")]
    [InlineData("business.facebook.com")]
    [InlineData("facebook.com")]
    public async Task WildcardPattern_MatchesSubdomainsAndBareDomain(string domain)
    {
        var result = await _rule.EvaluateAsync(Navigation(domain), PolicyWith("*.facebook.com"), CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(AlertType.BlacklistedWebsite, result!.Type);
    }

    [Fact]
    public async Task UnrelatedDomain_ProducesNoAlert()
    {
        var result = await _rule.EvaluateAsync(Navigation("example.com"), PolicyWith("*.facebook.com"), CancellationToken.None);
        Assert.Null(result);
    }

    [Fact]
    public async Task BlacklistDisabled_ProducesNoAlertEvenForMatchingDomain()
    {
        var policy = new PolicyDocument
        {
            Version = 1,
            Alert = new AlertPolicy { Blacklist = new BlacklistPolicy { Enabled = false, DomainPatterns = ["*.facebook.com"] } }
        };

        var result = await _rule.EvaluateAsync(Navigation("facebook.com"), policy, CancellationToken.None);
        Assert.Null(result);
    }

    [Fact]
    public async Task ExactDomainPatternWithoutWildcard_DoesNotMatchSubdomains()
    {
        var result = await _rule.EvaluateAsync(Navigation("m.facebook.com"), PolicyWith("facebook.com"), CancellationToken.None);
        Assert.Null(result);
    }
}
