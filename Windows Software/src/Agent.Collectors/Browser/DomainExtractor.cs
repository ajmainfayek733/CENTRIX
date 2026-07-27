namespace Agent.Collectors.Browser;

public interface IDomainExtractor
{
    string? ExtractDomain(string? normalizedUrl);
}

/// <summary>
/// Strips a single leading "www." label for blacklist-matching purposes, matching the spec's
/// own normalization example (https://www.facebook.com/ -> facebook.com). Does not attempt full
/// public-suffix-list-aware registrable-domain extraction — simple subdomain wildcard matching
/// (*.facebook.com) is all the Alert module's blacklist policy calls for.
/// </summary>
public sealed class DomainExtractor : IDomainExtractor
{
    public string? ExtractDomain(string? normalizedUrl)
    {
        if (string.IsNullOrWhiteSpace(normalizedUrl) || !Uri.TryCreate(normalizedUrl, UriKind.Absolute, out var uri))
        {
            return null;
        }

        var host = uri.Host.ToLowerInvariant();
        return host.StartsWith("www.", StringComparison.Ordinal) ? host[4..] : host;
    }
}
