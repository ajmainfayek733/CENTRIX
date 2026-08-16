namespace Agent.Collectors.Browser;

public enum UrlSchemeCategory
{
    Https,
    Http,
    InternalBrowserPage,
    File,
    Ftp,
    Data,
    Mailto,
    JavaScript,
    AboutBlank,
    Other,
    Invalid
}

public sealed record UrlClassification(UrlSchemeCategory Category, bool IsNavigable);

public interface IUrlValidator
{
    UrlClassification Classify(string? rawUrl);
}

/// <summary>
/// Covers every scheme the Browser Monitor spec explicitly lists: about:blank, chrome://
/// (and edge/brave/opera equivalents), file://, data:, mailto:, javascript:, ftp://.
/// javascript:/mailto:/data:/about:blank are classified non-navigable - they're not a page the
/// user is "visiting" in the sense productivity/blacklist policy cares about.
/// </summary>
public sealed class UrlValidator : IUrlValidator
{
    private static readonly HashSet<string> InternalBrowserSchemes =
        new(StringComparer.OrdinalIgnoreCase) { "chrome", "edge", "brave", "opera", "about", "chrome-extension" };

    public UrlClassification Classify(string? rawUrl)
    {
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            return new UrlClassification(UrlSchemeCategory.Invalid, IsNavigable: false);
        }

        if (rawUrl.Equals("about:blank", StringComparison.OrdinalIgnoreCase))
        {
            return new UrlClassification(UrlSchemeCategory.AboutBlank, IsNavigable: false);
        }

        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri))
        {
            return new UrlClassification(UrlSchemeCategory.Invalid, IsNavigable: false);
        }

        var scheme = uri.Scheme.ToLowerInvariant();
        return scheme switch
        {
            "https" => new UrlClassification(UrlSchemeCategory.Https, true),
            "http" => new UrlClassification(UrlSchemeCategory.Http, true),
            "file" => new UrlClassification(UrlSchemeCategory.File, true),
            "ftp" => new UrlClassification(UrlSchemeCategory.Ftp, true),
            "data" => new UrlClassification(UrlSchemeCategory.Data, false),
            "mailto" => new UrlClassification(UrlSchemeCategory.Mailto, false),
            "javascript" => new UrlClassification(UrlSchemeCategory.JavaScript, false),
            _ when InternalBrowserSchemes.Contains(scheme) => new UrlClassification(UrlSchemeCategory.InternalBrowserPage, true),
            _ => new UrlClassification(UrlSchemeCategory.Other, true)
        };
    }
}
