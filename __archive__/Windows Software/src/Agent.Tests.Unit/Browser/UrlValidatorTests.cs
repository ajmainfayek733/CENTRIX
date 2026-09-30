using Agent.Collectors.Browser;

namespace Agent.Tests.Unit.Browser;

public class UrlValidatorTests
{
    private readonly UrlValidator _validator = new();

    [Theory]
    [InlineData("about:blank", UrlSchemeCategory.AboutBlank, false)]
    [InlineData("https://example.com", UrlSchemeCategory.Https, true)]
    [InlineData("http://example.com", UrlSchemeCategory.Http, true)]
    [InlineData("chrome://settings", UrlSchemeCategory.InternalBrowserPage, true)]
    [InlineData("edge://flags", UrlSchemeCategory.InternalBrowserPage, true)]
    [InlineData("brave://settings", UrlSchemeCategory.InternalBrowserPage, true)]
    [InlineData("opera://settings", UrlSchemeCategory.InternalBrowserPage, true)]
    [InlineData("file:///C:/Users/test/report.pdf", UrlSchemeCategory.File, true)]
    [InlineData("data:text/plain;base64,SGVsbG8=", UrlSchemeCategory.Data, false)]
    [InlineData("mailto:someone@example.com", UrlSchemeCategory.Mailto, false)]
    [InlineData("javascript:alert(1)", UrlSchemeCategory.JavaScript, false)]
    [InlineData("ftp://ftp.example.com/file.txt", UrlSchemeCategory.Ftp, true)]
    [InlineData("https://localhost:5000/", UrlSchemeCategory.Https, true)]
    [InlineData("http://192.168.1.1/admin", UrlSchemeCategory.Http, true)]
    [InlineData("http://[::1]/", UrlSchemeCategory.Http, true)]
    public void Classify_HandlesEverySchemeFromTheSpec(string url, UrlSchemeCategory expectedCategory, bool expectedNavigable)
    {
        var result = _validator.Classify(url);

        Assert.Equal(expectedCategory, result.Category);
        Assert.Equal(expectedNavigable, result.IsNavigable);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not a url at all")]
    public void Classify_InvalidOrMissingInput_IsInvalidAndNotNavigable(string? url)
    {
        var result = _validator.Classify(url);

        Assert.Equal(UrlSchemeCategory.Invalid, result.Category);
        Assert.False(result.IsNavigable);
    }
}
