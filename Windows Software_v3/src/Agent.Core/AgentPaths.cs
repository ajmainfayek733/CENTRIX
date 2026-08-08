namespace Agent.Core;

/// <summary>
/// Well-known on-disk locations, all under ProgramData.
///
/// The service runs as SYSTEM and the host runs as the logged-on user, but only the service
/// touches the database and credential files — the host submits everything over the named pipe.
/// That split is deliberate: it means the ACL on this directory can deny ordinary users write
/// access to collected data without breaking the host.
/// </summary>
public static class AgentPaths
{
    public static string RootDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "EmployeeMonitor");

    /// <summary>Typed local telemetry store and offline queue.</summary>
    public static string DatabasePath => Path.Combine(RootDirectory, "agent.db");

    /// <summary>Server URL and enrollment token, written by the installer.</summary>
    public static string ConfigPath => Path.Combine(RootDirectory, "agent.config.json");

    /// <summary>DPAPI-protected device API key, written by the service after enrollment.</summary>
    public static string CredentialPath => Path.Combine(RootDirectory, "device.key");

    /// <summary>Screenshots staged here until they upload, then deleted.</summary>
    public static string ScreenshotSpoolDirectory => Path.Combine(RootDirectory, "screenshots");

    public static string LogDirectory => Path.Combine(RootDirectory, "logs");

    /// <summary>
    /// Named pipe between the SYSTEM service and the per-user host. "Global\" scopes it across
    /// terminal-services sessions, which is required because the two processes live in
    /// different sessions.
    /// </summary>
    public const string IpcPipeName = @"Global\EmployeeMonitor.Agent";

    public static void EnsureCreated()
    {
        Directory.CreateDirectory(RootDirectory);
        Directory.CreateDirectory(ScreenshotSpoolDirectory);
        Directory.CreateDirectory(LogDirectory);
    }
}
