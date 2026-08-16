using Agent.Collectors.Browser;

namespace Agent.Tests.Unit.Browser;

public class UriNormalizerTests
{
    private readonly UriNormalizer _normalizer = new();

    [Fact]
    public void DefaultHttpsPort_IsStripped()
    {
        var result = _normalizer.Normalize("https://Example.com:443/Path");
        Assert.Equal("https://example.com/Path", result);
    }

    [Fact]
    public void DefaultHttpPort_IsStripped()
    {
        var result = _normalizer.Normalize("http://example.com:80/");
        Assert.Equal("http://example.com/", result);
    }

    [Fact]
    public void NonDefaultPort_IsPreserved()
    {
        var result = _normalizer.Normalize("https://localhost:5000/");
        Assert.Equal("https://localhost:5000/", result);
    }

    [Fact]
    public void HostIsLowercased()
    {
        var result = _normalizer.Normalize("https://EXAMPLE.COM/Report");
        Assert.StartsWith("https://example.com", result);
    }

    [Fact]
    public void InternationalizedDomainName_IsConvertedToPunycode()
    {
        var result = _normalizer.Normalize("https://xn--e1aybc.xn--p1ai/");
        Assert.Contains("xn--", result);
    }

    [Fact]
    public void Ipv4Host_IsUnaffectedByIdnConversion()
    {
        var result = _normalizer.Normalize("http://192.168.1.1/admin");
        Assert.Equal("http://192.168.1.1/admin", result);
    }

    [Fact]
    public void Ipv6Host_IsUnaffectedByIdnConversion()
    {
        var result = _normalizer.Normalize("http://[::1]:8080/");
        Assert.Equal("http://[::1]:8080/", result);
    }

    [Fact]
    public void Localhost_IsUnaffectedByIdnConversion()
    {
        var result = _normalizer.Normalize("http://localhost/");
        Assert.Equal("http://localhost/", result);
    }

    [Fact]
    public void InvalidUrl_ReturnsNull()
    {
        Assert.Null(_normalizer.Normalize("not a url"));
        Assert.Null(_normalizer.Normalize(null));
    }
}
