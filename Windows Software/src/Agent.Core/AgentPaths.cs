namespace Agent.Core;

/// <summary>
/// Shared by both the service (Agent.Host) and the per-user tray helper (Agent.TrayHelper) -
/// both processes open the same encrypted SQLite database and DPAPI key files directly (DPAPI
/// LocalMachine scope is readable across users/processes on one machine, and SQLite's WAL mode
/// supports safe concurrent multi-process access), which is what lets the tray helper host the
/// interactive-only collectors without a custom IPC protocol between the two processes.
/// </summary>
public sealed class AgentPaths
{
    public string DataDirectory { get; set; } = @"C:\ProgramData\WorkforceAgent";

    public string BackendBaseUrl { get; set; } = "https://localhost/";

    public string DatabasePath => Path.Combine(DataDirectory, "agent.db");

    public string DatabaseKeyPath => Path.Combine(DataDirectory, "keys", "db.key");

    public string ScreenshotKeyPath => Path.Combine(DataDirectory, "keys", "screenshot.key");

    public string DeviceCredentialPath => Path.Combine(DataDirectory, "keys", "device.key");

    public string ScreenshotStorageDirectory => Path.Combine(DataDirectory, "screenshots");

    public string PolicyCachePath => Path.Combine(DataDirectory, "policy-cache.json");
}
