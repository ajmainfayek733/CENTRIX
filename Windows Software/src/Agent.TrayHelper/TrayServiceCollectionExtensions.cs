using Agent.Alerts;
using Agent.Alerts.Rules;
using Agent.Collectors.Activity;
using Agent.Collectors.AppSession;
using Agent.Collectors.Attendance;
using Agent.Collectors.Browser;
using Agent.Collectors.Screenshot;
using Agent.Core;
using Agent.Core.Consent;
using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Security;
using Agent.Core.Sync;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Input;
using Agent.Native.Sessions;
using Agent.Storage.Activity;
using Agent.Storage.Alerts;
using Agent.Storage.AppSession;
using Agent.Storage.Attendance;
using Agent.Storage.Browser;
using Agent.Storage.Consent;
using Agent.Storage.Screenshot;
using Agent.Storage.Security;
using Agent.Storage.Sqlite;
using Agent.Sync;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Agent.TrayHelper;

/// <summary>
/// Composition root for everything that must run in the interactive session: foreground-window
/// polling, GetLastInputInfo, UI Automation, and GDI screen capture all require an interactive
/// desktop, which a Session-0 service can never have. See Agent.Host for the Session-0 side.
/// </summary>
public static class TrayServiceCollectionExtensions
{
    public static IServiceCollection AddWorkforceAgentTray(this IServiceCollection services, AgentPaths options, NotifyIcon notifyIcon)
    {
        services.AddSingleton(options);
        services.AddSingleton<ISystemClock, SystemClock>();
        services.AddSingleton<IWtsSessionInfoProvider, WtsSessionInfoProvider>();
        services.AddSingleton<ICurrentUserProvider, CurrentUserProvider>();
        services.AddSingleton<IDeviceContextProvider, RegistryDeviceContextProvider>();

        services.AddSingleton<IIdleInputMonitor, IdleInputMonitor>();
        services.AddSingleton<IForegroundWindowMonitor, ForegroundWindowMonitor>();
        services.AddSingleton<ICpuUsageMonitor, CpuUsageMonitor>();
        services.AddSingleton<IScreenCapturer, ScreenCapturer>();
        services.AddSingleton<IVirtualScreenBoundsProvider, VirtualScreenBoundsProvider>();
        services.AddSingleton<IDesktopSessionDetector, DesktopSessionDetector>();
        services.AddSingleton<IDpiAwarenessManager, DpiAwarenessManager>();

        services.AddSingleton<SystemEventsSessionAndPowerBridge>();
        services.AddSingleton<ISessionEventSource>(sp => sp.GetRequiredService<SystemEventsSessionAndPowerBridge>());
        services.AddSingleton<IPowerEventSource>(sp => sp.GetRequiredService<SystemEventsSessionAndPowerBridge>());

        services.AddSingleton<ISqliteConnectionFactory>(_ =>
            new SqliteConnectionFactory(options.DatabasePath, new DpapiDatabaseKeyProvider(options.DatabaseKeyPath)));
        services.AddSingleton<IScreenshotEncryptor>(_ =>
            new AesGcmScreenshotEncryptor(new DpapiDatabaseKeyProvider(options.ScreenshotKeyPath)));

        services.AddSingleton<IAttendanceRepository, SqliteAttendanceRepository>();
        services.AddSingleton<IActivityRepository, SqliteActivityRepository>();
        services.AddSingleton<IAppSessionRepository, SqliteAppSessionRepository>();
        services.AddSingleton<SqliteBrowserMonitorRepository>();
        services.AddSingleton<IScreenshotRepository>(sp => new SqliteScreenshotRepository(
            sp.GetRequiredService<ISqliteConnectionFactory>(),
            sp.GetRequiredService<ILogger<SqliteScreenshotRepository>>()));
        services.AddSingleton<IAlertRepository, SqliteAlertRepository>();
        services.AddSingleton<IConsentStore, SqliteConsentStore>();

        services.AddSingleton<IDeviceCredentialStore>(_ => new DpapiDeviceCredentialStore(options.DeviceCredentialPath));
        services.AddTransient<DeviceAuthDelegatingHandler>();
        services.AddHttpClient<IBackendClient, HttpBackendClient>(client =>
                client.BaseAddress = new Uri(options.BackendBaseUrl))
            .AddHttpMessageHandler<DeviceAuthDelegatingHandler>();
        services.AddSingleton<IPolicyProvider>(sp => new RemotePolicyProvider(
            sp.GetRequiredService<IBackendClient>(),
            options.PolicyCachePath,
            sp.GetRequiredService<ILogger<RemotePolicyProvider>>()));
        services.AddHostedService(sp => (RemotePolicyProvider)sp.GetRequiredService<IPolicyProvider>());

        // Activity also implements IIdleStateSource — both App Session (via its own poll) and
        // Attendance (via TrayIdleAttendanceBridge) consume its idle transitions.
        services.AddSingleton<ActivityCollectorService>();
        services.AddSingleton<IIdleStateSource>(sp => sp.GetRequiredService<ActivityCollectorService>());
        services.AddHostedService(sp => sp.GetRequiredService<ActivityCollectorService>());
        services.AddHostedService<TrayIdleAttendanceBridge>();

        services.AddHostedService<AppSessionCollectorService>();

        services.AddSingleton<IBrowserDetector, BrowserDetector>();
        services.AddSingleton<IUriNormalizer, UriNormalizer>();
        services.AddSingleton<IDomainExtractor, DomainExtractor>();
        services.AddSingleton<IUrlValidator, UrlValidator>();
        services.AddSingleton<IBrowserAutomation, UiaBrowserAutomation>();
        services.AddSingleton<IAlertRule<BrowserNavigationEvent>, BlacklistedSiteRule>();
        services.AddSingleton<AlertEngine<BrowserNavigationEvent>>();
        services.AddSingleton<IBrowserMonitorRepository>(sp => new AlertingBrowserMonitorRepository(
            sp.GetRequiredService<SqliteBrowserMonitorRepository>(),
            sp.GetRequiredService<AlertEngine<BrowserNavigationEvent>>()));
        services.AddHostedService<BrowserMonitorCollectorService>();

        services.AddHostedService(sp => new ScreenshotCollectorService(
            sp.GetRequiredService<IScreenCapturer>(),
            sp.GetRequiredService<IVirtualScreenBoundsProvider>(),
            sp.GetRequiredService<IDesktopSessionDetector>(),
            sp.GetRequiredService<ISessionEventSource>(),
            sp.GetRequiredService<IPowerEventSource>(),
            sp.GetRequiredService<ICurrentUserProvider>(),
            sp.GetRequiredService<IDeviceContextProvider>(),
            sp.GetRequiredService<IScreenshotEncryptor>(),
            sp.GetRequiredService<IScreenshotRepository>(),
            sp.GetRequiredService<IPolicyProvider>(),
            sp.GetRequiredService<ISystemClock>(),
            sp.GetRequiredService<ILogger<ScreenshotCollectorService>>(),
            options.ScreenshotStorageDirectory));

        // Alert notification: the only process that can show UI, so it polls for ANY due alert
        // regardless of source (see PendingAlertNotificationPoller).
        var uiContext = SynchronizationContext.Current
            ?? throw new InvalidOperationException("Must be constructed on the WinForms UI thread.");
        services.AddSingleton<IAlertNotifier>(new BalloonAlertNotifier(notifyIcon, uiContext));
        services.AddHostedService<PendingAlertNotificationPoller>();

        return services;
    }
}
