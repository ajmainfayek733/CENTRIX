using Agent.Core;
using Agent.Core.Configuration;
using Agent.Core.Logging;
using Agent.Core.Storage;
using Agent.Service;
using Agent.Service.Backend;
using Agent.Service.Credentials;
using Agent.Service.Interop;
using Agent.Service.Ipc;
using Agent.Service.Workers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// Employee Monitor Agent - service half.
//
// Runs as LocalSystem in session 0. Owns policy, backend sync, USB events, the SQLite store and
// supervision of the per-user host. It deliberately never touches the interactive desktop: see
// HostSupervisorWorker for how the user-session half is started.

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options =>
{
    // Must match the name the installer registers, or the SCM will not find the service.
    options.ServiceName = "EmployeeMonitorAgent";
});

AgentPaths.EnsureCreated();

builder.Logging.AddEventLog(settings =>
{
    settings.SourceName = "EmployeeMonitorAgent";
});

// The Event Log holds warnings and errors well, but it is a poor place to read a sequence of
// events from - and diagnosing a workstation usually means asking for a file, not for remote
// Event Viewer access. Both sinks are registered; this is the one an admin is asked to send.
var serviceLogOptions = new FileLogOptions { FileNamePrefix = "service" };
builder.Logging.AddAgentFileLog(serviceLogOptions);

// Configuration is a hard dependency: without a server URL and enrollment token there is
// nothing to enroll against. Fail loudly at startup rather than running blind.
AgentConfiguration configuration;
try
{
    configuration = AgentConfiguration.Load();
}
catch (Exception ex)
{
    // This runs before the host exists, so the file sink has to be built by hand. It is worth
    // the few lines: a service that refuses to start is precisely when the log file is the only
    // evidence available.
    using var startupLogger = LoggerFactory.Create(b =>
    {
        b.AddEventLog(s => s.SourceName = "EmployeeMonitorAgent");
        b.AddProvider(FileLoggerBuilderExtensions.CreateStandalone(serviceLogOptions));
    });
    startupLogger.CreateLogger("Startup").LogCritical(ex, "Agent configuration is missing or invalid; service cannot start");
    throw;
}

builder.Services.AddSingleton(configuration);
builder.Services.AddSingleton<AgentState>();
builder.Services.AddSingleton<DeviceCredentialStore>();
builder.Services.AddSingleton<SessionLauncher>();

// The store is constructed eagerly so a schema failure surfaces at startup rather than on the
// first collector message.
builder.Services.AddSingleton(sp =>
{
    var store = new LocalStore(sp.GetRequiredService<ILogger<LocalStore>>());
    store.Initialize();
    return store;
});
builder.Services.AddSingleton<TelemetryQueue>();

builder.Services.AddHttpClient<BackendClient>((sp, client) =>
{
    var logger = sp.GetRequiredService<ILogger<BackendClient>>();
    client.BaseAddress = BackendClient.BuildBaseAddress(configuration, logger);

    // Generous enough for a screenshot upload on a slow office uplink, short enough that a
    // black-holed connection does not pin a sync cycle open indefinitely.
    client.Timeout = TimeSpan.FromSeconds(100);
    client.DefaultRequestHeaders.UserAgent.ParseAdd($"EmployeeMonitorAgent/{DeviceIdentity.GetAgentVersion()}");
});

// IpcServer is both a hosted service and a dependency of UsbWorker (which broadcasts
// notifications), so it is registered once and resolved for both roles.
builder.Services.AddSingleton<IpcServer>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<IpcServer>());

builder.Services.AddHostedService<ConnectivityWorker>();
builder.Services.AddHostedService<SyncWorker>();
// Signalling only, and entirely optional: if it never connects the agent still collects, still
// syncs on its interval, and still learns policy from the heartbeat. See RealtimeWorker.
builder.Services.AddHostedService<RealtimeWorker>();
builder.Services.AddHostedService<UsbWorker>();
builder.Services.AddHostedService<RetentionWorker>();
builder.Services.AddHostedService<HostSupervisorWorker>();

var host = builder.Build();
await host.RunAsync();
