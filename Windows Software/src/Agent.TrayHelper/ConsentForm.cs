namespace Agent.TrayHelper;

/// <summary>
/// Blocking first-run (and post-policy-change) disclosure. No collector starts until this is
/// acknowledged - see Program.cs's EnsureConsentAcknowledged. The written/signed acknowledgment
/// your organization's policy requires is an HR process outside this software; this dialog is
/// the technical enforcement half of that requirement and the record synced to the backend
/// (POST /api/v1/consent) as proof of notice. Once acknowledged by any user on this machine, it
/// is not shown again for the lifetime of the installation unless a higher policy version is
/// published (see IConsentStore.GetLatestForMachineAsync).
/// </summary>
public sealed class ConsentForm : Form
{
    private static readonly Color HeaderBackColor = Color.FromArgb(21, 32, 54);
    private static readonly Color HeaderAccentColor = Color.FromArgb(64, 132, 224);
    private static readonly Color BodyBackColor = Color.White;
    private static readonly Color FooterBackColor = Color.FromArgb(245, 246, 248);
    private static readonly Color SectionHeadingColor = Color.FromArgb(21, 32, 54);
    private static readonly Color MutedTextColor = Color.FromArgb(90, 97, 110);
    private static readonly Color PrimaryButtonColor = Color.FromArgb(37, 99, 235);

    private readonly Button _acknowledgeButton;
    private readonly CheckBox _confirmCheckBox;

    public ConsentForm(int policyVersion)
    {
        Text = "Workforce Agent - Monitoring Notice";
        ClientSize = new Size(680, 700);
        MinimumSize = new Size(680, 560);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowIcon = false;
        ShowInTaskbar = true;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.5f);
        BackColor = BodyBackColor;

        var footer = BuildFooter(policyVersion, out _confirmCheckBox, out _acknowledgeButton);
        var linkRow = BuildPolicyLinkRow();
        var header = BuildHeader(policyVersion);
        var body = BuildBody();

        // Dock order matters in WinForms: add bottom-docked controls first so Fill claims what's left.
        Controls.Add(body);
        Controls.Add(linkRow);
        Controls.Add(footer);
        Controls.Add(header);

        AcceptButton = _acknowledgeButton;
        ControlBox = true;
    }

    private static Panel BuildHeader(int policyVersion)
    {
        var header = new Panel { Dock = DockStyle.Top, Height = 92, BackColor = HeaderBackColor };

        var accentBar = new Panel { Dock = DockStyle.Bottom, Height = 3, BackColor = HeaderAccentColor };

        var titleLabel = new Label
        {
            Text = "This computer is monitored",
            ForeColor = Color.White,
            Font = new Font("Segoe UI Semibold", 14f, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(28, 18),
        };

        var subtitleLabel = new Label
        {
            Text = $"Workforce Agent monitoring notice - Policy version {policyVersion}",
            ForeColor = Color.FromArgb(198, 208, 226),
            Font = new Font("Segoe UI", 9.5f),
            AutoSize = true,
            Location = new Point(28, 50),
        };

        header.Controls.Add(titleLabel);
        header.Controls.Add(subtitleLabel);
        header.Controls.Add(accentBar);
        return header;
    }

    private static RichTextBox BuildBody()
    {
        var body = new RichTextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            BorderStyle = BorderStyle.None,
            BackColor = BodyBackColor,
            Margin = new Padding(0),
            ScrollBars = RichTextBoxScrollBars.Vertical,
        };

        // RichTextBox pads via its native margins rather than a Padding property.
        body.SelectionIndent = 8;
        body.SelectionRightIndent = 8;

        AppendParagraph(body,
            "This device is owned and provided by your employer for work purposes. It runs the Workforce " +
            "Agent, workplace management software that records attendance, active working time, application " +
            "and browser usage, and endpoint security events. This is disclosed, transparent monitoring - " +
            "the Agent is always visible in Task Manager and Programs and Features, and it contains no " +
            "remote-control, remote-shell, or remote screen-viewing capability.");

        AppendHeading(body, "What is collected");
        AppendBullets(body,
        [
            "Login, logout, lock, unlock, and idle/active time",
            "Application name, window title, and duration in the foreground",
            "Domain and URL of websites visited in a supported browser",
            "Periodic screenshots - only if enabled by your administrator; disabled by default",
            "USB storage device connection and disconnection events",
        ]);

        AppendHeading(body, "What is never collected");
        AppendBullets(body,
        [
            "The content of what you type - no keystroke logging of content, only that input occurred",
            "Personal email, private messages, or personal social media content",
            "Login credentials, passwords, or the contents of personal accounts",
            "Any activity while you are not logged into this device with your work account",
        ]);

        AppendHeading(body, "Your rights");
        AppendParagraph(body,
            "Subject to applicable law, you may have the right to access, correct, or request deletion of " +
            "your data, and to be notified of material changes to this policy before they take effect. Full " +
            "detail, including retention periods, legal basis, and how to exercise these rights, is set out " +
            "in the complete Terms of Use and Privacy Policy - use the links below to read them in full " +
            "before acknowledging this notice.");

        body.Select(0, 0);
        return body;
    }

    private static void AppendHeading(RichTextBox box, string text)
    {
        if (box.TextLength > 0)
        {
            box.AppendText("\n\n");
        }

        var start = box.TextLength;
        box.AppendText(text);
        box.Select(start, text.Length);
        box.SelectionFont = new Font("Segoe UI Semibold", 11f, FontStyle.Bold);
        box.SelectionColor = SectionHeadingColor;
        box.Select(box.TextLength, 0);
        box.SelectionFont = new Font("Segoe UI", 9.5f);
        box.SelectionColor = Color.Black;
        box.AppendText("\n");
    }

    private static void AppendParagraph(RichTextBox box, string text)
    {
        if (box.TextLength > 0)
        {
            box.AppendText("\n\n");
        }

        box.SelectionFont = new Font("Segoe UI", 9.5f);
        box.SelectionColor = Color.Black;
        box.AppendText(text);
    }

    private static void AppendBullets(RichTextBox box, IReadOnlyList<string> items)
    {
        foreach (var item in items)
        {
            box.AppendText("\n");
            box.SelectionBullet = true;
            box.SelectionFont = new Font("Segoe UI", 9.5f);
            box.SelectionColor = Color.Black;
            box.AppendText(item);
        }

        box.SelectionBullet = false;
    }

    private static Panel BuildPolicyLinkRow()
    {
        var row = new Panel { Dock = DockStyle.Top, Height = 40, BackColor = BodyBackColor, Padding = new Padding(20, 4, 20, 4) };

        var termsLink = MakeLinkButton("Read the full Terms of Use");
        termsLink.Left = 0;
        termsLink.Click += (_, _) => ShowPolicyDocument("Workforce Agent - Terms of Use", "Agent.TrayHelper.Policies.terms-of-service.md");

        var privacyLink = MakeLinkButton("Read the full Privacy Policy");
        privacyLink.Left = termsLink.Right + 24;
        privacyLink.Click += (_, _) => ShowPolicyDocument("Workforce Agent - Privacy Policy", "Agent.TrayHelper.Policies.privacy-policy.md");

        row.Controls.Add(termsLink);
        row.Controls.Add(privacyLink);
        return row;
    }

    private static LinkLabel MakeLinkButton(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
        LinkColor = PrimaryButtonColor,
        ActiveLinkColor = PrimaryButtonColor,
        LinkBehavior = LinkBehavior.HoverUnderline,
        Top = 8,
    };

    private static void ShowPolicyDocument(string title, string embeddedResourceLogicalName)
    {
        using var viewer = new PolicyDocumentViewerForm(title, embeddedResourceLogicalName);
        viewer.ShowDialog();
    }

    private Panel BuildFooter(int policyVersion, out CheckBox confirmCheckBox, out Button acknowledgeButton)
    {
        var footer = new Panel { Dock = DockStyle.Bottom, Height = 118, BackColor = FooterBackColor, Padding = new Padding(20, 14, 20, 16) };
        var topBorder = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Color.FromArgb(224, 226, 231) };

        var confirmCheckBoxLocal = new CheckBox
        {
            Text = "I have read and understood this notice, the Terms of Use, and the Privacy Policy.",
            AutoSize = true,
            Font = new Font("Segoe UI", 9.5f),
            Location = new Point(0, 8),
        };
        confirmCheckBoxLocal.CheckedChanged += (_, _) => UpdateAcknowledgeButtonState(confirmCheckBoxLocal);
        confirmCheckBox = confirmCheckBoxLocal;

        var effectiveLabel = new Label
        {
            Text = $"Policy version {policyVersion}. Your acknowledgement is recorded with the date and time, and applies for as long as this Agent remains installed, unless the policy changes materially.",
            AutoSize = false,
            Width = 640,
            Height = 32,
            ForeColor = MutedTextColor,
            Font = new Font("Segoe UI", 8.5f),
            Location = new Point(0, 32),
        };

        var declineButton = new Button
        {
            Text = "Decline",
            DialogResult = DialogResult.Cancel,
            Width = 110,
            Height = 36,
            FlatStyle = FlatStyle.Flat,
            Location = new Point(640 - 110 - 220 - 12, 72),
        };
        declineButton.FlatAppearance.BorderColor = Color.FromArgb(200, 203, 209);

        acknowledgeButton = new Button
        {
            Text = "I Acknowledge && Agree",
            DialogResult = DialogResult.OK,
            Width = 220,
            Height = 36,
            FlatStyle = FlatStyle.Flat,
            BackColor = PrimaryButtonColor,
            ForeColor = Color.White,
            Enabled = false,
            Location = new Point(640 - 220, 72),
        };
        acknowledgeButton.FlatAppearance.BorderSize = 0;

        footer.Controls.Add(confirmCheckBox);
        footer.Controls.Add(effectiveLabel);
        footer.Controls.Add(declineButton);
        footer.Controls.Add(acknowledgeButton);
        footer.Controls.Add(topBorder);

        return footer;
    }

    private void UpdateAcknowledgeButtonState(CheckBox confirmCheckBox) => _acknowledgeButton.Enabled = confirmCheckBox.Checked;
}
