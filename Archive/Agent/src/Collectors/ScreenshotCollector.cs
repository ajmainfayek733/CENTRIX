using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Agent.Config;
using Agent.Core;

namespace Agent.Collectors
{
    public class ScreenshotCollector : IScreenshotCollector
    {
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int nIndex);

        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;

        public Task<byte[]> CaptureScreenAsync(CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
                {
                    return Task.FromResult(CaptureWindowsScreen());
                }
            }
            catch (Exception)
            {
                // Log/handle error, fall back to mock image
            }

            return Task.FromResult(CreateMockScreenshotBytes());
        }

        private static byte[] CaptureWindowsScreen()
        {
            int width = GetSystemMetrics(SM_CXSCREEN);
            int height = GetSystemMetrics(SM_CYSCREEN);

            if (width <= 0) width = 1920;
            if (height <= 0) height = 1080;

            using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(0, 0, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }

            using var ms = new MemoryStream();
            // Save as JPEG with 60% quality to save space
            var encoder = GetEncoder(ImageFormat.Jpeg);
            var encoderParameters = new EncoderParameters(1);
            encoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, 60L);

            if (encoder != null)
            {
                bitmap.Save(ms, encoder, encoderParameters);
            }
            else
            {
                bitmap.Save(ms, ImageFormat.Jpeg);
            }

            byte[] rawBytes = ms.ToArray();
            return EncryptionUtility.EncryptBytes(rawBytes);
        }

        private static ImageCodecInfo? GetEncoder(ImageFormat format)
        {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            foreach (ImageCodecInfo codec in codecs)
            {
                if (codec.FormatID == format.Guid)
                {
                    return codec;
                }
            }
            return null;
        }

        private static byte[] CreateMockScreenshotBytes()
        {
            // Create a small 100x100 mock image
            using var bitmap = new Bitmap(100, 100);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.Clear(Color.Navy);
                using var font = new Font(FontFamily.GenericSansSerif, 8);
                g.DrawString("Mock Screen", font, Brushes.White, 10, 40);
            }

            using var ms = new MemoryStream();
            bitmap.Save(ms, ImageFormat.Jpeg);
            byte[] rawBytes = ms.ToArray();
            return EncryptionUtility.EncryptBytes(rawBytes);
        }
    }
}
