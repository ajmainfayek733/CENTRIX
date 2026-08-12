using Agent.Collectors.Browser;

namespace Agent.Tests.Unit.Browser;

public class DomainExtractorTests
{
    private readonly DomainExtractor _extractor = new();

    [Fact]
    public void LeadingWww_IsStripped()
    {
        // Spec's own normalization example: https://www.facebook.com/ -> facebook.com
        var domain = _extractor.ExtractDomain("https://www.facebook.com/");
        Assert.Equal("facebook.com", domain);
    }

    [Theory]
    [InlineData("https://m.facebook.com/", "m.facebook.com")]
    [InlineData("https://business.facebook.com/", "business.facebook.com")]
    [InlineData("https://facebook.com/", "facebook.com")]
    public void OnlyLeadingWwwIsStripped_OtherSubdomainsArePreserved(string url, string expectedDomain)
    {
        var domain = _extractor.ExtractDomain(url);
        Assert.Equal(expectedDomain, domain);
    }

    [Fact]
    public void HostIsLowercased()
    {
        var domain = _extractor.ExtractDomain("https://WWW.Example.COM/");
        Assert.Equal("example.com", domain);
    }

    [Fact]
    public void InvalidUrl_ReturnsNull()
    {
        Assert.Null(_extractor.ExtractDomain(null));
        Assert.Null(_extractor.ExtractDomain("not a url"));
    }
}
