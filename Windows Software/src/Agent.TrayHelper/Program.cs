using Agent.Core;
using Agent.Core.Consent;
using Agent.Core.Identity;
using Agent.Core.Sync;
using Agent.TrayHelper;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;

namespace Agent.TrayHelper;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

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
                Path.Combine(options.DataDirectory, "logs", "tray-.log"),
                formatProvider: System.Globalization.CultureInfo.InvariantCulture,
                rollingInterval: Serilog.RollingInterval.Day,
                retainedFileCountLimit: 30)
            .CreateLogger();

        try
        {
            var trayContext = new TrayApplicationContext();

            var services = new ServiceCollection();
            services.AddLogging(builder => builder.AddSerilog());
            services.AddWorkforceAgentTray(options, trayContext.NotifyIcon);
            var provider = services.BuildServiceProvider();

            DeviceEnrollmentBootstrapper.EnsureEnrolledAsync(
                provider.GetRequiredService<IDeviceCredentialStore>(),
                provider.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(DeviceEnrollmentBootstrapper)),
                CancellationToken.None).GetAwaiter().GetResult();

            if (!EnsureConsentAcknowledged(provider, options).GetAwaiter().GetResult())
            {
                Log.Warning("Consent not acknowledged; exiting without starting any collector.");
                return;
            }

            var hostedServices = provider.GetServices<IHostedService>().ToList();
            foreach (var hostedService in hostedServices)
            {
                hostedService.StartAsync(CancellationToken.None).GetAwaiter().GetResult();
            }

            Application.ApplicationExit += (_, _) =>
            {
                foreach (var hostedService in hostedServices)
                {
                    hostedService.StopAsync(CancellationToken.None).GetAwaiter().GetResult();
                }
            };

            Application.Run(trayContext);
        }
        catch (Exception ex)
        {
            Log.Fatal(ex, "Agent.TrayHelper terminated unexpectedly.");
        }
        finally
        {
            Log.CloseAndFlush();
        }
    }

    private static async Task<bool> EnsureConsentAcknowledged(IServiceProvider provider, AgentPaths options)
    {
        var currentUserProvider = provider.GetRequiredService<Agent.Native.ICurrentUserProvider>();
        var deviceContext = provider.GetRequiredService<Agent.Core.Identity.IDeviceContextProvider>();
        var policyProvider = provider.GetRequiredService<Agent.Core.Policy.IPolicyProvider>();
        var consentStore = provider.GetRequiredService<IConsentStore>();
        var backendClient = provider.GetRequiredService<IBackendClient>();
        var logger = provider.GetRequiredService<ILogger<ConsentForm>>();

        // Not wtsSessionInfo.TryGetUserSid: that calls WTSQueryUserToken, which requires the
        // SE_TCB_NAME privilege held by LocalSystem — not by this process, which always runs as
        // the interactive user already and can just ask for its own identity.
        var userSid = currentUserProvider.GetCurrentUserSid();
        if (string.IsNullOrEmpty(userSid))
        {
            return false;
        }

        var machineId = deviceContext.Current.MachineId;
        var policyVersion = policyProvider.Current.Version;

        // Gate on the machine, not the current user: once any employee on this device has
        // acknowledged the current policy, the notice is not shown again for the lifetime of the
        // installation — re-prompting every other Windows account that logs into the same
        // machine would contradict "ask once for the life of the agent" and just train people to
        // click through without reading. It resurfaces only when a materially higher policy
        // version is published.
        var machineConsent = await consentStore.GetLatestForMachineAsync(machineId, CancellationToken.None).ConfigureAwait(false);
        if (machineConsent is not null && machineConsent.PolicyVersion >= policyVersion)
        {
            return true;
        }

        using var form = new ConsentForm(policyVersion);
        if (form.ShowDialog() != DialogResult.OK)
        {
            return false;
        }

        var record = new ConsentRecord(userSid, machineId, policyVersion, DateTimeOffset.UtcNow);
        await consentStore.SaveAsync(record, CancellationToken.None).ConfigureAwait(false);

        // Best-effort: the local record already satisfies the gate above regardless of whether
        // this succeeds. If the backend is unreachable right now, ConsentGateHostedService /
        // the next Agent.Host sync cycle will still see the local row directly — the only thing
        // a failure here delays is the backend's own copy of the proof-of-notice.
        var synced = await backendClient.PostConsentAsync(record, CancellationToken.None).ConfigureAwait(false);
        if (!synced)
        {
            logger.LogWarning("Acknowledged consent was saved locally but could not be synced to the backend yet; it will be retried implicitly on next contact.");
        }

        return true;
    }
}
