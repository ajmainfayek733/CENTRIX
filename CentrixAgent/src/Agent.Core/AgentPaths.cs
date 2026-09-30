namespace Agent.Core;

/// <summary>
/// Well-known on-disk locations, all under ProgramData.
///
/// The service runs as SYSTEM and the host runs as the logged-on user, but only the service
/// touches the database and credential files - the host submits everything over the named pipe.
/// That split is deliberate: it means the ACL on this directory can deny ordinary users write
/// access to collected data without breaking the host.
/// </summary>
public static class AgentPaths
{
    public static string RootDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Centrix");

    /// <summary>Typed local telemetry store and offline queue.</summary>
    public static string DatabasePath => Path.Combine(RootDirectory, "agent.db");

    /// <summary>Server URL and enrollment token, written by the installer.</summary>
    public static string ConfigPath => Path.Combine(RootDirectory, "agent.config.json");

    /// <summary>DPAPI-protected device API key, written by the service after enrollment.</summary>
    public static string CredentialPath => Path.Combine(RootDirectory, "device.key");

    /// <summary>Screenshots staged here until they upload, then deleted.</summary>
    public static string ScreenshotSpoolDirectory => Path.Combine(RootDirectory, "screenshots");

    /// <summary>Host-side backlog for IPC messages that could not be sent while the service pipe was down.</summary>
    public static string HostIpcQueuePath => Path.Combine(RootDirectory, "host-ipc-queue.jsonl");

    public static string LogDirectory => Path.Combine(RootDirectory, "logs");

    /// <summary>
    /// Named pipe between the SYSTEM service and the per-user host. "Global\" scopes it across
    /// terminal-services sessions, which is required because the two processes live in
    /// different sessions.
    /// </summary>
    public const string IpcPipeName = @"Global\Centrix.Agent";

    /// <summary>
    /// Event Log sources, one per process.
    ///
    /// Registered by the installer, not by the processes that use them. Creating a source writes
    /// under HKLM and "takes administrator privileges" - the service could manage it as SYSTEM,
    /// but the host runs as the logged-on employee and cannot, so a host on a machine where the
    /// source was never registered would fail to open its Event Log sink. Microsoft's guidance is
    /// to create sources "as part of an .msi installation", which is what the configure step does.
    ///
    /// Named here rather than written as literals at each sink, so that the name the installer
    /// registers and the name the logger opens cannot drift apart.
    /// </summary>
    public const string ServiceEventLogSource = "CentrixAgent";

    public const string HostEventLogSource = "CentrixHost";

    /// <summary>The log both sources write into.</summary>
    public const string EventLogName = "Application";

    public static void EnsureCreated()
    {
        Directory.CreateDirectory(RootDirectory);
        Directory.CreateDirectory(ScreenshotSpoolDirectory);
        Directory.CreateDirectory(LogDirectory);
    }
}
