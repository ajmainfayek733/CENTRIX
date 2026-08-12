using System.ServiceProcess;
using Agent.Core;
using Agent.Core.Identity;
using Agent.Host;
using Serilog;

var configuration = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: false)
    .Build();

var options = configuration.GetSection("Agent").Get<AgentPaths>() ?? new AgentPaths();
Directory.CreateDirectory(options.DataDirectory);

Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(configuration)
    .Enrich.FromLogContext()
    .WriteTo.File(
        Path.Combine(options.DataDirectory, "logs", "agent-.log"),
        formatProvider: System.Globalization.CultureInfo.InvariantCulture,
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 30)
    .CreateLogger();

try
{
    var builder = Host.CreateApplicationBuilder(args);
    builder.Configuration.AddConfiguration(configuration);
    builder.Services.AddWorkforceAgentHost(options);
    builder.Services.AddSerilog();

    using var host = builder.Build();
    using var service = new AgentWindowsService(host);

    // Best-effort: does nothing if already enrolled, and does not block service startup if not
    // (SyncWorker/ScreenshotUploadWorker will keep 401ing and logging clearly until an admin
    // provisions this device - see DeviceAuthDelegatingHandler).
    await DeviceEnrollmentBootstrapper.EnsureEnrolledAsync(
        host.Services.GetRequiredService<IDeviceCredentialStore>(),
        host.Services.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(DeviceEnrollmentBootstrapper)),
        CancellationToken.None).ConfigureAwait(false);

    if (Environment.UserInteractive)
    {
        // Local/dev convenience: `dotnet run` without installing the service.
        Log.Information("Running interactively - install as a Windows Service for production use.");
        service.StartInteractive(args);

        Console.WriteLine("Press Enter to stop.");
        Console.ReadLine();

        service.StopInteractive();
    }
    else
    {
        ServiceBase.Run(service);
    }
}
catch (Exception ex)
{
    Log.Fatal(ex, "Agent.Host terminated unexpectedly.");
}
finally
{
    Log.CloseAndFlush();
}
