using System.Reflection;

namespace Agent.TrayHelper;

/// <summary>
/// Read-only viewer for the full Terms of Use / Privacy Policy text, shipped as embedded
/// resources (see Agent.TrayHelper.csproj) so ConsentForm can link to the complete documents
/// without depending on a network call or a file the installer has to remember to lay down.
/// </summary>
public sealed class PolicyDocumentViewerForm : Form
{
    public PolicyDocumentViewerForm(string title, string embeddedResourceLogicalName)
    {
        Text = title;
        Width = 760;
        Height = 720;
        MinimumSize = new Size(480, 360);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9.5f);
        AutoScaleMode = AutoScaleMode.Dpi;
        Icon = null;

        var textBox = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            Dock = DockStyle.Fill,
            BorderStyle = BorderStyle.None,
            Font = new Font("Segoe UI", 10f),
            BackColor = Color.White,
            Padding = new Padding(20),
            Text = LoadEmbeddedText(embeddedResourceLogicalName),
        };

        var contentPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16), BackColor = Color.White };
        contentPanel.Controls.Add(textBox);

        var closeButton = new Button
        {
            Text = "Close",
            DialogResult = DialogResult.OK,
            Width = 100,
            Height = 32,
            Anchor = AnchorStyles.Right,
        };
        var footer = new Panel { Dock = DockStyle.Bottom, Height = 56, Padding = new Padding(16, 12, 16, 12) };
        closeButton.Left = footer.ClientSize.Width - closeButton.Width - 16;
        closeButton.Top = 12;
        closeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        footer.Controls.Add(closeButton);

        Controls.Add(contentPanel);
        Controls.Add(footer);
        AcceptButton = closeButton;
        CancelButton = closeButton;
    }

    private static string LoadEmbeddedText(string logicalName)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(logicalName);
        if (stream is null)
        {
            return "This document could not be loaded from the Agent installation. Contact your IT administrator.";
        }

        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
