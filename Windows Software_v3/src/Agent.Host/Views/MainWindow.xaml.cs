using System.ComponentModel;
using System.Security.Principal;
using System.Windows;
using System.Windows.Media;
using Agent.Core;
using Agent.Core.Ipc;
using Agent.Core.Policy;
using Agent.Host.Ipc;
using Agent.Host.Themes;

namespace Agent.Host.Views;

/// <summary>
/// The employee-facing disclosure window (spec section 3: monitoring must be transparent, and
/// the agent must not hide itself). It shows what is collected, what is not, and captures the
/// acknowledgement that Features.md and the spec both require before monitoring is legitimate.
/// </summary>
public partial class MainWindow : Window
{
    private readonly HostIpcClient _ipc;
    private readonly string _userSid;

    /// <summary>
    /// Closing the window hides it to the tray instead of exiting. The agent must keep running
    /// - but it must also stay visible and killable, so the tray icon is never hidden.
    /// </summary>
    private bool _reallyClosing;

    public MainWindow(HostIpcClient ipc)
    {
        InitializeComponent();

        _ipc = ipc;

        var identity = WindowsIdentity.GetCurrent();
        _userSid = identity.User?.Value ?? "S-1-0-0";

        VersionText.Text = $"Agent {DeviceIdentity.GetAgentVersion()} - this workstation is monitored under company policy";
        UserText.Text = identity.Name;
        ThemeButton.Content = $"Theme: {ThemeManager.Current}";

        _ipc.PolicyUpdated += OnPolicyUpdated;
        _ipc.ConnectionStateChanged += OnConnectionStateChanged;

        RenderPolicy(_ipc.Policy, consentRequired: false);
        SetConnectionState(_ipc.IsConnected);
    }

    private void OnPolicyUpdated(AgentPolicy policy, bool consentRequired) =>
        Dispatcher.Invoke(() => RenderPolicy(policy, consentRequired));

    private void OnConnectionStateChanged(bool connected) =>
        Dispatcher.Invoke(() => SetConnectionState(connected));

    private void SetConnectionState(bool connected)
    {
        StatusText.Text = connected
            ? "Monitoring is active and connected to the company server."
            : "Monitoring is active. Data is being stored locally until the server is reachable.";

        StatusDot.Fill = connected
            ? (System.Windows.Media.Brush)FindResource("AccentBrush")
            : (System.Windows.Media.Brush)FindResource("WarningBrush");
    }

    /// <summary>
    /// Builds the disclosure lists from the policy actually in force, so the window reflects
    /// what is really running rather than a hard-coded description that could drift from it.
    /// </summary>
    private void RenderPolicy(AgentPolicy policy, bool consentRequired)
    {
        PolicyVersionText.Text = policy.Version.ToString();

        var collected = new List<string>();

        if (policy.Attendance.Enabled)
            collected.Add("Your first sign-in and last sign-out each working day.");

        if (policy.AppSession.Enabled)
            collected.Add("Which application is in the foreground, and its window title, with how long it stays there.");

        if (policy.Activity.Enabled)
            collected.Add($"Whether you are active or idle, using a {policy.Activity.IdleThresholdSeconds / 60}-minute inactivity threshold.");

        if (policy.BrowserMonitor.Enabled)
            collected.Add("The web addresses you visit in your browser, and how long you spend on each.");

        collected.Add("Counts of key presses and mouse clicks, as an activity level only.");

        if (policy.Usb.Enabled)
            collected.Add("When a USB storage device or phone is connected or removed - never its contents.");

        if (policy.Screenshot.Enabled)
            collected.Add($"A screenshot of your desktop every {policy.Screenshot.IntervalSeconds / 60} minutes.");

        CollectedList.ItemsSource = collected;

        // Fixed list: these are architectural guarantees, not policy settings, and they must
        // read the same regardless of how the policy is configured.
        NotCollectedList.ItemsSource = new List<string>
        {
            "The actual keys you type. Only the number of key presses is counted, never the characters - so passwords and message content are never captured.",
            "The contents of any USB device, file or document.",
            "Personal email, chat message content, or account credentials.",
            "Anything at all when this agent is not running - it is visible in Task Manager and listed in Installed Programs."
        };

        ConsentCard.Visibility = consentRequired ? Visibility.Visible : Visibility.Collapsed;

        // A policy change the employee has not acknowledged is the one case where the window
        // shows itself rather than waiting to be opened from the tray.
        if (consentRequired && !IsVisible) ShowWindow();
    }

    private async void OnAcknowledge(object sender, RoutedEventArgs e)
    {
        AcknowledgeButton.IsEnabled = false;

        await _ipc.SendAsync(new ConsentAcknowledgedMessage
        {
            UserSid = _userSid,
            PolicyVersion = _ipc.Policy.Version,
            AcknowledgedAt = DateTimeOffset.UtcNow
        }).ConfigureAwait(true);

        ConsentCard.Visibility = Visibility.Collapsed;
        AcknowledgeButton.IsEnabled = true;
    }

    /// <summary>
    /// Deliberately only hides the prompt for this session. Monitoring continues either way -
    /// this button is not a consent opt-out, and the prompt returns on the next sign-in until
    /// it is acknowledged.
    /// </summary>
    private void OnRemindLater(object sender, RoutedEventArgs e)
    {
        ConsentCard.Visibility = Visibility.Collapsed;
        Hide();
    }

    private void OnToggleTheme(object sender, RoutedEventArgs e)
    {
        var theme = ThemeManager.Cycle();
        ThemeButton.Content = $"Theme: {theme}";

        // The status dot's brush was resolved from the old dictionary, so re-resolve it.
        SetConnectionState(_ipc.IsConnected);
    }

    public void ShowWindow()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_reallyClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }

        _ipc.PolicyUpdated -= OnPolicyUpdated;
        _ipc.ConnectionStateChanged -= OnConnectionStateChanged;
        base.OnClosing(e);
    }

    /// <summary>Called by the application shell during a real shutdown.</summary>
    public void AllowClose() => _reallyClosing = true;
}
