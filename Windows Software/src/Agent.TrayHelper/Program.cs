using Agent.Core;
using Agent.Core.Consent;
using Agent.TrayHelper;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
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

        // Not wtsSessionInfo.TryGetUserSid: that calls WTSQueryUserToken, which requires the
        // SE_TCB_NAME privilege held by LocalSystem — not by this process, which always runs as
        // the interactive user already and can just ask for its own identity.
        var userSid = currentUserProvider.GetCurrentUserSid();
        if (string.IsNullOrEmpty(userSid))
        {
            return false;
        }

        var policyVersion = policyProvider.Current.Version;
        var existing = await consentStore.GetAsync(userSid, CancellationToken.None).ConfigureAwait(false);
        if (existing is not null && existing.PolicyVersion >= policyVersion)
        {
            return true;
        }

        using var form = new ConsentForm(policyVersion);
        if (form.ShowDialog() != DialogResult.OK)
        {
            return false;
        }

        await consentStore.SaveAsync(
            new ConsentRecord(userSid, deviceContext.Current.MachineId, policyVersion, DateTimeOffset.UtcNow),
            CancellationToken.None).ConfigureAwait(false);

        return true;
    }
}
