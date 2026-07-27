using System.Globalization;

namespace Agent.Collectors.Browser;

public interface IUriNormalizer
{
    string? Normalize(string? rawUrl);
}

/// <summary>
/// Lowercases scheme/host, strips default ports, and converts IDN hosts to their ASCII
/// (Punycode) form deterministically via <see cref="IdnMapping"/> — not relying on ambient
/// System.Uri IDN behavior, which has varied across .NET versions. IPv4/IPv6 literal hosts are
/// passed through unchanged (IDNA label rules don't apply to them and would throw).
/// </summary>
public sealed class UriNormalizer : IUriNormalizer
{
    private static readonly IdnMapping Idn = new();

    public string? Normalize(string? rawUrl)
    {
        if (string.IsNullOrWhiteSpace(rawUrl) || !Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri))
        {
            return null;
        }

        var builder = new UriBuilder(uri) { Host = NormalizeHost(uri.Host) };

        if ((builder.Scheme == Uri.UriSchemeHttp && builder.Port == 80) ||
            (builder.Scheme == Uri.UriSchemeHttps && builder.Port == 443))
        {
            builder.Port = -1;
        }

        return builder.Uri.ToString();
    }

    private static string NormalizeHost(string host)
    {
        if (Uri.CheckHostName(host) != UriHostNameType.Dns)
        {
            return host.ToLowerInvariant();
        }

        try
        {
            return Idn.GetAscii(host).ToLowerInvariant();
        }
        catch (ArgumentException)
        {
            return host.ToLowerInvariant();
        }
    }
}
