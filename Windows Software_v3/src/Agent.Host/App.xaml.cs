using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using Agent.Core;
using Agent.Core.Logging;
using Agent.Host.Collectors;
using Agent.Host.Ipc;
using Agent.Host.Services;
using Agent.Host.Themes;
using Agent.Host.Views;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Agent.Host;

/// <summary>
/// Employee Monitor Agent - interactive half.
///
/// Runs in the logged-on user's session because everything it does is session-bound: the
/// foreground window, idle time, input counts and the screen itself are all invisible from
/// session 0, where the service lives. It holds no credentials and writes nothing durable -
/// observations go to the service over the named pipe, and the service owns storage and upload.
/// </summary>
public partial class App : System.Windows.Application
{
    private IHost? _host;
    private HostIpcClient? _ipc;
    private TrayIconService? _tray;
    private MainWindow? _window;
    private CancellationTokenSource? _connectCts;

    /// <summary>
    /// Single-instance guard. The service supervisor checks by process name before launching,
    /// but a race between its check and the launch could otherwise start two hosts, which
    /// would double-count every keystroke.
    /// </summary>
    private static Mutex? _singleInstance;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Local scope: one host per interactive session is correct, and a Global mutex would
        // wrongly block a second user during fast user switching.
        _singleInstance = new Mutex(true, @"Local\EmployeeMonitor.Host", out var isFirstInstance);
        if (!isFirstInstance)
        {
            Shutdown();
            return;
        }

        ThemeManager.Apply(AppTheme.System);

        _host = BuildHost();
        _ipc = _host.Services.GetRequiredService<HostIpcClient>();
        _tray = _host.Services.GetRequiredService<TrayIconService>();

        var alerts = _host.Services.GetRequiredService<AlertEngine>();
        alerts.NotificationRequested += n => Dispatcher.Invoke(() => _tray!.ShowNotification(n));
        _ipc.NotificationRequested += n => Dispatcher.Invoke(() => _tray!.ShowNotification(n));

        _tray.Initialize();
        _tray.OpenRequested += () => Dispatcher.Invoke(ShowMainWindow);

        // Input hooks must be installed from a thread with a message pump, which is this one.
        // Installing them from a background worker yields hooks that never fire.
        _host.Services.GetRequiredService<InputCounter>().Start();

        _connectCts = new CancellationTokenSource();
        _ = ConnectLoopAsync(_connectCts.Token);
        _ = _host.StartAsync();

        DispatcherUnhandledException += OnDispatcherUnhandledException;
    }

    private IHost BuildHost()
    {
        var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder();

        builder.Logging.AddEventLog(settings => settings.SourceName = AgentPaths.HostEventLogSource);

        // Per terminal-services session, not per process: fast user switching runs one host per
        // logged-on user simultaneously, and they must not append to the same handle. The
        // single-instance mutex above guarantees at most one writer per session id.
        builder.Logging.AddAgentFileLog(new FileLogOptions
        {
            FileNamePrefix = $"host-s{Process.GetCurrentProcess().SessionId}"
        });

        builder.Services.AddSingleton<HostIpcClient>();
        builder.Services.AddSingleton<ForegroundWindowTracker>();
        builder.Services.AddSingleton<BrowserUrlExtractor>();
        builder.Services.AddSingleton<InputCounter>();
        builder.Services.AddSingleton<ScreenshotCapturer>();
        builder.Services.AddSingleton<SessionEventMonitor>();
        builder.Services.AddSingleton<AlertEngine>();
        builder.Services.AddSingleton<TrayIconService>();

        builder.Services.AddHostedService<MonitoringOrchestrator>();

        return builder.Build();
    }

    /// <summary>
    /// Keeps trying to reach the service. The host is usually started by the service, but it
    /// can also outlive a service restart, so reconnection has to be continuous rather than a
    /// one-shot attempt at startup.
    /// </summary>
    private async Task ConnectLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            if (_ipc is { IsConnected: false })
            {
                await _ipc.ConnectAsync(ct).ConfigureAwait(false);
            }

            await Task.Delay(TimeSpan.FromSeconds(10), ct).ConfigureAwait(false);
        }
    }

    private void ShowMainWindow()
    {
        _window ??= new MainWindow(_ipc!);
        _window.ShowWindow();
    }

    /// <summary>
    /// A crash in the UI thread must not take monitoring down with it - the window is a
    /// disclosure surface, and collection runs on background workers that are unaffected.
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        var logger = _host?.Services.GetService<ILogger<App>>();
        logger?.LogError(e.Exception, "Unhandled UI exception; keeping the agent running");
        e.Handled = true;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _connectCts?.Cancel();

        _window?.AllowClose();
        _tray?.Dispose();

        _host?.Services.GetService<InputCounter>()?.Dispose();
        _host?.Services.GetService<SessionEventMonitor>()?.Dispose();
        _host?.Services.GetService<BrowserUrlExtractor>()?.Dispose();

        if (_host is not null)
        {
            // Bounded so a wedged worker cannot hang logoff; Windows kills the process
            // shortly after this anyway.
            _host.StopAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            _host.Dispose();
        }

        _ipc?.DisposeAsync().AsTask().GetAwaiter().GetResult();
        _singleInstance?.Dispose();

        base.OnExit(e);
    }
}
