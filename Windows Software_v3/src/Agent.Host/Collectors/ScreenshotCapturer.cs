using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using Agent.Core;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Collectors;

public sealed record CapturedScreenshot(Guid ClientEventId, string FilePath, long SizeBytes, int Width, int Height, DateTimeOffset CapturedAt);

/// <summary>
/// Features.md "Periodic ScreenShots". Optional, policy-controlled, and off by default in a
/// published build.
///
/// Captures the full virtual desktop (all monitors) as one JPEG. The file is written to the
/// shared spool directory and only its path crosses the IPC boundary - the service uploads the
/// bytes. That keeps a multi-megabyte frame out of the pipe that also carries time-sensitive
/// activity events.
/// </summary>
public sealed class ScreenshotCapturer(ILogger<ScreenshotCapturer> logger)
{
    private readonly ILogger<ScreenshotCapturer> _logger = logger;

    private static readonly ImageCodecInfo? JpegCodec = ImageCodecInfo
        .GetImageEncoders()
        .FirstOrDefault(c => c.MimeType == "image/jpeg");

    public CapturedScreenshot? Capture(int jpegQuality)
    {
        try
        {
            // SystemInformation.VirtualScreen is the bounding box of every monitor, so a
            // multi-monitor desk yields one image rather than only the primary display.
            var bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                _logger.LogWarning("Virtual screen reported no area; skipping capture");
                return null;
            }

            using var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                // KNOWN LIMITATION: layered windows are not captured.
                //
                // The underlying BitBlt omits windows layered on top of the target unless the
                // CAPTUREBLT raster flag is set, and CopyPixelOperation.CaptureBlt exists for
                // exactly that. It cannot be used here: CopyFromScreen throws
                // InvalidEnumArgumentException for any value that "is not a member of
                // CopyPixelOperation", and SourceCopy | CaptureBlt is a combination, not a member.
                // Passing it would fail every capture rather than improve one.
                //
                // Getting layered windows means calling BitBlt directly with SRCCOPY | CAPTUREBLT
                // against a screen DC, which is a deliberate change to make with a test pass
                // behind it - CAPTUREBLT also forces layered windows to redraw and can flicker.
                graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
            }

            AgentPaths.EnsureCreated();

            var clientEventId = Guid.NewGuid();
            var capturedAt = DateTimeOffset.UtcNow;
            var path = Path.Combine(AgentPaths.ScreenshotSpoolDirectory, $"{clientEventId}.jpg");

            Save(bitmap, path, jpegQuality);

            var size = new FileInfo(path).Length;
            _logger.LogInformation("Captured screenshot {Id} ({Width}x{Height}, {Size} bytes)",
                clientEventId, bounds.Width, bounds.Height, size);

            return new CapturedScreenshot(clientEventId, path, size, bounds.Width, bounds.Height, capturedAt);
        }
        catch (Exception ex)
        {
            // A capture can fail legitimately: the secure desktop is up (UAC prompt, lock
            // screen) and CopyFromScreen is denied. Skip this interval rather than crash.
            _logger.LogWarning(ex, "Screenshot capture failed; skipping this interval");
            return null;
        }
    }

    private static void Save(Bitmap bitmap, string path, int jpegQuality)
    {
        var quality = Math.Clamp(jpegQuality, 10, 100);

        if (JpegCodec is null)
        {
            // No JPEG encoder registered is not a configuration we expect, but PNG keeps the
            // feature working rather than silently producing nothing.
            bitmap.Save(path, ImageFormat.Png);
            return;
        }

        using var parameters = new EncoderParameters(1);
        using var qualityParameter = new EncoderParameter(Encoder.Quality, (long)quality);
        parameters.Param[0] = qualityParameter;

        bitmap.Save(path, JpegCodec, parameters);
    }
}
