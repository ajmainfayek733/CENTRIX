using System.IO;

namespace Agent.Collectors.Browser;

public enum BrowserType
{
    Unknown,
    Chrome,
    Edge,
    Brave,
    Opera,
    Firefox
}

public interface IBrowserDetector
{
    BrowserType Detect(string executablePath);
}

public sealed class BrowserDetector : IBrowserDetector
{
    private static readonly Dictionary<string, BrowserType> KnownExecutables = new(StringComparer.OrdinalIgnoreCase)
    {
        ["chrome.exe"] = BrowserType.Chrome,
        ["msedge.exe"] = BrowserType.Edge,
        ["brave.exe"] = BrowserType.Brave,
        ["opera.exe"] = BrowserType.Opera,
        ["firefox.exe"] = BrowserType.Firefox
    };

    public BrowserType Detect(string executablePath)
    {
        var fileName = Path.GetFileName(executablePath);
        return KnownExecutables.GetValueOrDefault(fileName, BrowserType.Unknown);
    }
}
