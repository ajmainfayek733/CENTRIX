using System.Drawing;
using System.Windows.Forms;
using Agent.Core.Contracts;
using Agent.Core.Ipc;
using Microsoft.Extensions.Logging;

namespace Agent.Host.Services;

/// <summary>
/// The tray icon and its balloon notifications.
///
/// Spec section 3 requires the agent be discoverable rather than hidden, and recommends a visible
/// indicator. This is that indicator: it is always present while monitoring runs, and it is
/// what raises the alert notifications Features.md describes.
///
/// Windows Forms NotifyIcon rather than a WPF equivalent because WPF has no tray API at all -
/// every WPF tray library wraps this same control.
/// </summary>
public sealed class TrayIconService(ILogger<TrayIconService> logger) : IDisposable
{
    private readonly ILogger<TrayIconService> _logger = logger;
    private NotifyIcon? _icon;

    public event Action? OpenRequested;

    public void Initialize()
    {
        var menu = new ContextMenuStrip();

        menu.Items.Add("Open monitoring notice", null, (_, _) => OpenRequested?.Invoke());
        menu.Items.Add(new ToolStripSeparator());

        // No "Exit" item. The service restarts the host within seconds anyway, so offering an
        // exit that silently undoes itself would be misleading. Task Manager still works -
        // the agent is not hiding, it is just not offering a self-defeating button.
        var about = new ToolStripMenuItem($"CENTRIX {Agent.Core.DeviceIdentity.GetAgentVersion()}")
        {
            Enabled = false
        };
        menu.Items.Add(about);

        _icon = new NotifyIcon
        {
            Icon = BuildIcon(),
            Text = "CENTRIX - monitoring is active",
            Visible = true,
            ContextMenuStrip = menu
        };

        _icon.DoubleClick += (_, _) => OpenRequested?.Invoke();
        _logger.LogInformation("Tray icon initialized");
    }

    public void ShowNotification(ShowNotificationMessage notification)
    {
        if (_icon is null) return;

        var icon = notification.Severity switch
        {
            AlertSeverity.Critical or AlertSeverity.High => ToolTipIcon.Warning,
            AlertSeverity.Warning => ToolTipIcon.Warning,
            _ => ToolTipIcon.Info
        };

        // The timeout argument has been ignored by Windows since Vista - the shell decides how
        // long a balloon stays up. Passed for API compatibility only.
        _icon.ShowBalloonTip(5000, notification.Title, notification.Message, icon);
        _logger.LogInformation("Notification shown: {Title}", notification.Title);
    }

    /// <summary>
    /// Draws the icon rather than shipping a .ico. Keeps the single-file publish free of an
    /// embedded resource for what is a filled circle, and guarantees it renders at whatever
    /// size the shell asks for.
    /// </summary>
    private static Icon BuildIcon()
    {
        using var bitmap = new Bitmap(32, 32);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);

            using var ring = new Pen(Color.FromArgb(255, 34, 197, 94), 3f);
            graphics.DrawEllipse(ring, 4, 4, 23, 23);

            using var centre = new SolidBrush(Color.FromArgb(255, 34, 197, 94));
            graphics.FillEllipse(centre, 12, 12, 8, 8);
        }

        // Icon.FromHandle does not own the GDI handle, so the icon is cloned and the original
        // handle destroyed - otherwise every construction leaks one.
        var handle = bitmap.GetHicon();
        try
        {
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            NativeIcon.DestroyIcon(handle);
        }
    }

    public void Dispose()
    {
        if (_icon is null) return;

        _icon.Visible = false;
        _icon.Dispose();
        _icon = null;
    }
}

internal static partial class NativeIcon
{
    [System.Runtime.InteropServices.LibraryImport("user32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    internal static partial bool DestroyIcon(IntPtr handle);
}
