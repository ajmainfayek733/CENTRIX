namespace Agent.TrayHelper;

/// <summary>
/// Blocking first-run (and post-policy-change) disclosure. No collector starts until this is
/// acknowledged — see Program.cs. The written/signed acknowledgment your organization's policy
/// requires is an HR process outside this software; this dialog is the technical enforcement
/// half of that requirement and the record synced to the backend as proof of notice.
/// </summary>
public sealed class ConsentForm : Form
{
    public ConsentForm(int policyVersion)
    {
        Text = "Workforce Agent — Monitoring Notice";
        Width = 560;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        var label = new Label
        {
            Text =
                "This computer is monitored by your employer's Workforce Agent software.\n\n" +
                "What is collected:\n" +
                "  - Login/logout, lock/unlock, and active vs. idle time\n" +
                "  - Application usage (name, window title, duration)\n" +
                "  - Websites visited (domain and URL)\n" +
                "  - Periodic screenshots, if enabled by your administrator\n" +
                "  - USB storage device connections\n\n" +
                "What is never collected:\n" +
                "  - Keystroke content, passwords, or personal account contents\n" +
                "  - Personal email, messages, or social media content\n\n" +
                "This software does not hide itself, evade Task Manager, or allow remote\n" +
                "control of this computer. It is visible in Task Manager and Programs and\n" +
                "Features at all times.\n\n" +
                $"Policy version {policyVersion}. By clicking Acknowledge, you confirm you have\n" +
                "been notified of this monitoring, consistent with your organization's policy\n" +
                "and applicable data protection law.",
            Dock = DockStyle.Top,
            Height = 320,
            Padding = new Padding(16),
            AutoSize = false
        };

        var acknowledgeButton = new Button
        {
            Text = "Acknowledge",
            DialogResult = DialogResult.OK,
            Dock = DockStyle.Bottom,
            Height = 40
        };

        Controls.Add(label);
        Controls.Add(acknowledgeButton);
        AcceptButton = acknowledgeButton;
        ControlBox = false;
    }
}
