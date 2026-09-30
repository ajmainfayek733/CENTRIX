namespace Agent.Core.Policy;

public sealed record ScreenshotPolicy
{
    /// <summary>Disabled by default - admin must explicitly opt in per confirmed policy.</summary>
    public bool Enabled { get; init; }

    public TimeSpan CaptureInterval { get; init; } = TimeSpan.FromMinutes(10);

    public int JpegQuality { get; init; } = 70;
}
