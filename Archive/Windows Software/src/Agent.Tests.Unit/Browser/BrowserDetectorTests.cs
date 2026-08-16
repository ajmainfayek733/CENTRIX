using Agent.Collectors.Browser;

namespace Agent.Tests.Unit.Browser;

public class BrowserDetectorTests
{
    private readonly BrowserDetector _detector = new();

    [Theory]
    [InlineData(@"C:\Program Files\Google\Chrome\Application\chrome.exe", BrowserType.Chrome)]
    [InlineData(@"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", BrowserType.Edge)]
    [InlineData(@"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe", BrowserType.Brave)]
    [InlineData(@"C:\Program Files\Opera\opera.exe", BrowserType.Opera)]
    [InlineData(@"C:\Program Files\Mozilla Firefox\firefox.exe", BrowserType.Firefox)]
    [InlineData(@"C:\Windows\System32\notepad.exe", BrowserType.Unknown)]
    public void Detect_MatchesByExecutableFileName(string path, BrowserType expected)
    {
        Assert.Equal(expected, _detector.Detect(path));
    }
}
