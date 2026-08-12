using Agent.Core.Contracts;

namespace Agent.Core.Configuration;

/// <summary>
/// Install-time configuration (spec section 11: "Agent pulls its server address and token from a
/// config file set at install time"). Written by the installer to
/// <see cref="AgentPaths.ConfigPath"/> and read by the service at startup.
///
/// This file holds the org-wide enrollment token, which is traded once for a per-device API
/// key. It is not itself a telemetry credential - the backend refuses it on every route except
/// enrollment - but it does let a machine join the fleet, so the installer must ACL the
/// directory to Administrators and SYSTEM.
/// </summary>
public sealed record AgentConfiguration
{
    /// <summary>Base URL of the monitoring server, e.g. https://monitoring.example.com</summary>
    public required string ServerUrl { get; init; }

    /// <summary>Org enrollment token issued by the dashboard when the organization was created.</summary>
    public required string EnrollmentToken { get; init; }

    /// <summary>
    /// Allows plain HTTP, for a lab or first-run smoke test only. Spec section 9 requires
    /// HTTPS in production and the service logs a warning on every start when this is true.
    /// </summary>
    public bool AllowInsecureHttp { get; init; }

    public static AgentConfiguration Load()
    {
        if (!File.Exists(AgentPaths.ConfigPath))
        {
            throw new FileNotFoundException(
                $"Agent configuration not found at {AgentPaths.ConfigPath}. " +
                "The installer must write ServerUrl and EnrollmentToken before the service starts.",
                AgentPaths.ConfigPath);
        }

        var json = File.ReadAllText(AgentPaths.ConfigPath);
        var config = AgentJson.Deserialize<AgentConfiguration>(json)
                     ?? throw new InvalidDataException($"{AgentPaths.ConfigPath} is not valid agent configuration");

        if (string.IsNullOrWhiteSpace(config.ServerUrl))
            throw new InvalidDataException("Agent configuration is missing ServerUrl");
        if (string.IsNullOrWhiteSpace(config.EnrollmentToken))
            throw new InvalidDataException("Agent configuration is missing EnrollmentToken");

        return config;
    }

    /// <summary>Used by the installer and by developer setup to write the file.</summary>
    public void Save()
    {
        AgentPaths.EnsureCreated();
        File.WriteAllText(AgentPaths.ConfigPath, AgentJson.Serialize(this));
    }
}
