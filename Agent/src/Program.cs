using System;
using System.IO;
using System.Net.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Hosting.WindowsServices;
using Agent.Core;
using Agent.Collectors;
using Agent.Buffering;
using Agent.Sync;
using Agent.Config;
using Agent.Service;

namespace Agent
{
    public static class Program
    {
        public static void Main(string[] args)
        {
            var options = new HostApplicationBuilderSettings
            {
                Args = args,
                ContentRootPath = WindowsServiceHelpers.IsWindowsService() 
                    ? AppContext.BaseDirectory 
                    : null
            };

            var builder = Host.CreateApplicationBuilder(options);
            
            // Set up Windows Service integration
            builder.Services.AddWindowsService(config =>
            {
                config.ServiceName = "CompanyActivityMonitor";
            });

            // Register raw Win32 / PInvoke layer
            if (OperatingSystem.IsWindows())
            {
                builder.Services.AddSingleton<IWin32Service, WindowsWin32Service>();
            }
            else
            {
                // Decouple dependencies: fallback/mock for non-Windows platforms
                builder.Services.AddSingleton<IWin32Service, SimulationWin32Service>();
            }

            // Register Collectors (Single Responsibility Principle)
            builder.Services.AddSingleton<IActivityCollector, AppFocusCollector>();
            builder.Services.AddSingleton<IIdleDetector, IdleStateCollector>();
            builder.Services.AddSingleton<IActivityLevelDetector, ActivityLevelCollector>();
            builder.Services.AddSingleton<IScreenshotCollector, ScreenshotCollector>();
            
            builder.Services.AddSingleton<IUsbDeviceCollector>(sp => 
            {
                var config = sp.GetRequiredService<IAgentConfigProvider>();
                return new UsbDeviceCollector(config.GetDeviceId());
            });

            // Register Local Queue / Buffer (Durable offline storage)
            builder.Services.AddSingleton<ILocalStore, SqliteLocalStore>();

            // Register Config Provider
            builder.Services.AddSingleton<HttpClient>();
            builder.Services.AddSingleton<IAgentConfigProvider, RemoteConfigProvider>();

            // Register HTTP Sync Client
            builder.Services.AddSingleton<ISyncClient, HttpSyncClient>();

            // Register background orchestrator service
            builder.Services.AddHostedService<MonitoringWindowsService>();

            var host = builder.Build();
            host.Run();
        }
    }
}
