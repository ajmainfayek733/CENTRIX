using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Agent.Native;

public sealed record CapturedImage(byte[] JpegBytes, int Width, int Height);

public interface IScreenCapturer
{
    /// <summary>Null on any capture failure (driver reset, GDI exhaustion, etc.) — callers retry
    /// on the next scheduled interval rather than treating this as fatal.</summary>
    CapturedImage? Capture(VirtualScreenBounds bounds, int jpegQuality);
}

[SupportedOSPlatform("windows")]
public sealed class ScreenCapturer : IScreenCapturer
{
    // [DllImport("user32.dll")]
    public CapturedImage? Capture(VirtualScreenBounds bounds, int jpegQuality)
    {
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            return null;
        }

        try
        {
            using var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, new Size(bounds.Width, bounds.Height), CopyPixelOperation.SourceCopy);
            }

            using var stream = new MemoryStream();
            using var encoderParams = new EncoderParameters(1);
            encoderParams.Param[0] = new EncoderParameter(Encoder.Quality, jpegQuality);
            bitmap.Save(stream, GetJpegEncoder(), encoderParams);

            return new CapturedImage(stream.ToArray(), bounds.Width, bounds.Height);
        }
        catch (Exception ex) when (ex is OutOfMemoryException or ExternalException or InvalidOperationException)
        {
            // GDI+ notoriously reports many unrelated capture failures (driver resets, resource
            // exhaustion) as a generic OutOfMemoryException — this is documented GDI+ behavior,
            // not literal memory exhaustion, so it's treated as a transient capture failure.
            return null;
        }
    }

    private static ImageCodecInfo GetJpegEncoder() =>
        ImageCodecInfo.GetImageEncoders().First(codec => codec.FormatID == ImageFormat.Jpeg.Guid);
}
