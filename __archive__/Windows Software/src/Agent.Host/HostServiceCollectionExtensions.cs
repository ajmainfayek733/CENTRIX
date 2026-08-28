using Agent.Alerts;
using Agent.Alerts.Rules;
using Agent.Core;
using Agent.Collectors.Activity;
using Agent.Collectors.Attendance;
using Agent.Collectors.Browser;
using Agent.Collectors.Usb;
using Agent.Core.Consent;
using Agent.Core.Identity;
using Agent.Core.Policy;
using Agent.Core.Security;
using Agent.Core.Sync;
using Agent.Core.Time;
using Agent.Native;
using Agent.Native.Input;
using Agent.Native.Sessions;
using Agent.Storage.Alerts;
using Agent.Storage.Attendance;
using Agent.Storage.Activity;
using Agent.Storage.Browser;
using Agent.Storage.Consent;
using Agent.Storage.Outbox;
using Agent.Storage.Security;
using Agent.Storage.Sqlite;
using Agent.Storage.Usb;
using Agent.Sync;

namespace Agent.Host;

/// <summary>
/// Composition root for everything that runs in the Session-0 service: session/power/USB
/// signals, Sync/Alerts (which need the network or run as a single writer against the outbox),
/// and read access to data the tray helper writes for the interactive-only collectors. See
/// Agent.TrayHelper for the composition root of what runs in the interactive session.
/// </summary>
public static class HostServiceCollectionExtensions
{
    public static IServiceCollection AddWorkforceAgentHost(this IServiceCollection services, AgentPaths options)
    {
        services.AddSingleton(options);
        services.AddSingleton<ISystemClock, SystemClock>();
        services.AddSingleton<IWtsSessionInfoProvider, WtsSessionInfoProvider>();
        services.AddSingleton<IUsbDeviceEnumerator, WmiUsbDeviceEnumerator>();

        services.AddSingleton<IDeviceContextProvider, RegistryDeviceContextProvider>();

        // Native session/power bridge: AgentWindowsService (ServiceBase) publishes into these;
        // collectors consume only the interface, never System.ServiceProcess directly.
        services.AddSingleton<SessionEventPublisher>();
        services.AddSingleton<ISessionEventSource>(sp => sp.GetRequiredService<SessionEventPublisher>());
        services.AddSingleton<PowerEventPublisher>();
        services.AddSingleton<IPowerEventSource>(sp => sp.GetRequiredService<PowerEventPublisher>());

        // Idle events for Attendance are supplied by the tray helper writing directly to the
        // shared database (see TrayIdleAttendanceBridge) - the service process has no
        // interactive-session idle signal of its own.
        services.AddSingleton<IIdleStateSource, NullIdleStateSource>();

        services.AddSingleton<ISqliteConnectionFactory>(_ =>
            new SqliteConnectionFactory(options.DatabasePath, new DpapiDatabaseKeyProvider(options.DatabaseKeyPath)));
        services.AddSingleton<SchemaInitializer>();

        services.AddSingleton<IScreenshotEncryptor>(_ =>
            new AesGcmScreenshotEncryptor(new DpapiDatabaseKeyProvider(options.ScreenshotKeyPath)));

        services.AddSingleton<IOutboxRepository, SqliteOutboxRepository>();
        services.AddSingleton<IAttendanceRepository, SqliteAttendanceRepository>();
        services.AddSingleton<IActivityRepository, SqliteActivityRepository>();
        services.AddSingleton<IBrowserMonitorRepository, SqliteBrowserMonitorRepository>();
        services.AddSingleton<Agent.Collectors.Screenshot.IScreenshotRepository, Agent.Storage.Screenshot.SqliteScreenshotRepository>();
        services.AddSingleton<SqliteUsbLogRepository>();
        services.AddSingleton<IAlertRepository, SqliteAlertRepository>();
        services.AddSingleton<IConsentStore, SqliteConsentStore>();

        services.AddSingleton<IDeviceCredentialStore>(_ => new DpapiDeviceCredentialStore(options.DeviceCredentialPath));
        services.AddTransient<DeviceAuthDelegatingHandler>();
        services.AddHttpClient<IBackendClient, HttpBackendClient>(client =>
                client.BaseAddress = new Uri(options.BackendBaseUrl))
            .AddHttpMessageHandler<DeviceAuthDelegatingHandler>();

        // Agent.Host has no interactive desktop to show the consent dialog itself (that's
        // Agent.TrayHelper's job) - this gate starts closed and is opened by
        // ConsentGateHostedService once it observes an acknowledgement recorded by any user on
        // this machine, so SyncWorker/ScreenshotUploadWorker never transmit before that happens.
        services.AddSingleton<ConsentGate>();
        services.AddHostedService<ConsentGateHostedService>();

        services.AddSingleton<IPolicyProvider>(sp => new RemotePolicyProvider(
            sp.GetRequiredService<IBackendClient>(),
            options.PolicyCachePath,
            sp.GetRequiredService<ILogger<RemotePolicyProvider>>()));
        services.AddHostedService(sp => (RemotePolicyProvider)sp.GetRequiredService<IPolicyProvider>());

        // Attendance: session/power-driven events only in this process (see NullIdleStateSource).
        services.AddSingleton<AttendanceRecoveryService>();
        services.AddHostedService<AttendanceCollectorService>();

        services.AddHostedService<UsbLogCollectorService>();

        // Alerts: USB and idle-escalation are evaluated here since their source data is
        // Host-observable or DB-readable; the tray helper evaluates browser-navigation alerts
        // where that event actually originates. IAlertNotifier is a no-op here - the tray
        // helper's PendingAlertNotificationPoller displays alerts regardless of which process
        // created them, by reading the shared alerts table.
        services.AddSingleton<IAlertNotifier, NullAlertNotifier>();
        services.AddSingleton<IAlertRule<UsbDeviceEvent>, UsbViolationRule>();
        services.AddSingleton<AlertEngine<UsbDeviceEvent>>();
        services.AddSingleton<IUsbLogRepository>(sp => new AlertingUsbLogRepository(
            sp.GetRequiredService<SqliteUsbLogRepository>(),
            sp.GetRequiredService<AlertEngine<UsbDeviceEvent>>()));
        services.AddSingleton<IAlertRule<ActivitySessionRecord>, IdleAlertRule>();
        services.AddSingleton<AlertEngine<ActivitySessionRecord>>();
        services.AddHostedService<IdleAlertPeriodicChecker>();

        services.AddHostedService<SyncWorker>();
        services.AddHostedService(sp => new ScreenshotUploadWorker(
            sp.GetRequiredService<Agent.Collectors.Screenshot.IScreenshotRepository>(),
            sp.GetRequiredService<IScreenshotEncryptor>(),
            sp.GetRequiredService<IBackendClient>(),
            sp.GetRequiredService<IPolicyProvider>(),
            sp.GetRequiredService<ConsentGate>(),
            sp.GetRequiredService<ILogger<ScreenshotUploadWorker>>()));

        return services;
    }
}
