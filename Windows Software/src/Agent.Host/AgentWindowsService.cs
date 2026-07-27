using System.ServiceProcess;
using Agent.Collectors.Attendance;
using Agent.Native.Sessions;
using Agent.Storage.Sqlite;

namespace Agent.Host;

/// <summary>
/// Classic ServiceBase rather than the generic host's WindowsServiceLifetime: only ServiceBase
/// exposes OnSessionChange/OnPowerEvent, which the generic host's simplified wrapper does not
/// (confirmed against Microsoft Learn and open dotnet/runtime issues before choosing this
/// approach — see the architecture plan). A generic IHost is built and run internally so DI,
/// configuration, and hosted services still work exactly as they would under UseWindowsService.
/// </summary>
public sealed class AgentWindowsService : ServiceBase
{
    private readonly IHost _host;

    public AgentWindowsService(IHost host)
    {
        _host = host;
        ServiceName = "WorkforceAgent";
        CanHandleSessionChangeEvent = true;
        CanHandlePowerEvent = true;
        CanShutdown = true;
    }

    /// <summary>Exposed as internal (rather than left protected-only) so Program.cs can drive
    /// the same startup path when running interactively for local development, without
    /// resorting to reflection to reach ServiceBase's protected members.</summary>
    internal void StartInteractive(string[] args) => OnStart(args);

    internal void StopInteractive() => OnStop();

    protected override void OnStart(string[] args)
    {
        using var scope = _host.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<SchemaInitializer>().EnsureCreated();
        scope.ServiceProvider.GetRequiredService<AttendanceRecoveryService>().RecoverAsync(CancellationToken.None).GetAwaiter().GetResult();

        _host.Start();
    }

    protected override void OnStop()
    {
        _host.StopAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
    }

    protected override void OnShutdown() => OnStop();

    protected override void OnSessionChange(SessionChangeDescription changeDescription)
    {
        var reason = MapReason(changeDescription.Reason);
        if (reason is { } mappedReason)
        {
            var publisher = _host.Services.GetRequiredService<SessionEventPublisher>();
            var clock = _host.Services.GetRequiredService<Agent.Core.Time.ISystemClock>();
            publisher.Publish(new SessionChangeNotification(mappedReason, changeDescription.SessionId, clock.UtcNow));
        }

        base.OnSessionChange(changeDescription);
    }

    protected override bool OnPowerEvent(PowerBroadcastStatus powerStatus)
    {
        var kind = MapPowerStatus(powerStatus);
        if (kind is { } mappedKind)
        {
            var publisher = _host.Services.GetRequiredService<PowerEventPublisher>();
            var clock = _host.Services.GetRequiredService<Agent.Core.Time.ISystemClock>();
            publisher.Publish(new PowerChangeNotification(mappedKind, clock.UtcNow));
        }

        // Never deny a suspend query — a monitoring agent must never block OS power transitions.
        return true;
    }

    private static SessionChangeReasonKind? MapReason(SessionChangeReason reason) => reason switch
    {
        SessionChangeReason.ConsoleConnect => SessionChangeReasonKind.ConsoleConnect,
        SessionChangeReason.ConsoleDisconnect => SessionChangeReasonKind.ConsoleDisconnect,
        SessionChangeReason.RemoteConnect => SessionChangeReasonKind.RemoteConnect,
        SessionChangeReason.RemoteDisconnect => SessionChangeReasonKind.RemoteDisconnect,
        SessionChangeReason.SessionLogon => SessionChangeReasonKind.SessionLogon,
        SessionChangeReason.SessionLogoff => SessionChangeReasonKind.SessionLogoff,
        SessionChangeReason.SessionLock => SessionChangeReasonKind.SessionLock,
        SessionChangeReason.SessionUnlock => SessionChangeReasonKind.SessionUnlock,
        SessionChangeReason.SessionRemoteControl => SessionChangeReasonKind.SessionRemoteControl,
        _ => null
    };

    private static PowerChangeKind? MapPowerStatus(PowerBroadcastStatus status) => status switch
    {
        PowerBroadcastStatus.Suspend => PowerChangeKind.Suspend,
        PowerBroadcastStatus.ResumeAutomatic => PowerChangeKind.ResumeAutomatic,
        PowerBroadcastStatus.ResumeSuspend => PowerChangeKind.ResumeSuspend,
        PowerBroadcastStatus.ResumeCritical => PowerChangeKind.ResumeCritical,
        PowerBroadcastStatus.BatteryLow => PowerChangeKind.BatteryLow,
        PowerBroadcastStatus.PowerStatusChange => PowerChangeKind.PowerStatusChange,
        _ => null
    };
}
