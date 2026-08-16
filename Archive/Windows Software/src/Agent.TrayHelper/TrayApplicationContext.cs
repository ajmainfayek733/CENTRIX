namespace Agent.TrayHelper;

/// <summary>
/// No visible main window - a tray icon only. The context menu is deliberately minimal
/// (status/about, no way to pause or exit monitoring): "Admin is in control" per Rules.md, not
/// the employee.
/// </summary>
public sealed class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;

    public TrayApplicationContext()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Workforce Agent is active", null, (_, _) => { }).Enabled = false;
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("About", null, OnAbout);

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Shield,
            Text = "Workforce Agent",
            Visible = true,
            ContextMenuStrip = menu
        };
    }

    public NotifyIcon NotifyIcon => _notifyIcon;

    private static void OnAbout(object? sender, EventArgs e) =>
        MessageBox.Show(
            "Workforce Agent monitors this company-owned device per your organization's disclosed policy.",
            "Workforce Agent",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _notifyIcon.Dispose();
        }

        base.Dispose(disposing);
    }
}
