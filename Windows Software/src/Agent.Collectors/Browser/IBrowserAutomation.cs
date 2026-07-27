namespace Agent.Collectors.Browser;

public interface IBrowserAutomation
{
    /// <summary>Null on any failure — closed window, no address bar found, COM/UIA exception.</summary>
    string? TryExtractUrl(nint windowHandle, BrowserType browserType);
}
