using System.ComponentModel;
using System.Diagnostics;
using System.Security;
using System.Security.AccessControl;
using System.Security.Principal;
using Agent.Core;
using Agent.Core.Configuration;

namespace Agent.Service.Setup;

/// <summary>
/// The install-time configuration step, invoked as
/// <c>Centrix.Service.exe --configure --server-url ... --enrollment-token ...</c>.
///
/// It lives in the service executable rather than in the installer so that there is exactly one
/// implementation of "lay out ProgramData and write the agent configuration". The MSI calls it,
/// and so does Deploy-Agent.ps1 - an installer that wrote the file itself would be a second
/// definition of the layout the service depends on, free to drift from it.
///
/// Runs as LocalSystem from a deferred custom action. It must therefore be conservative: it
/// reports failure through the exit code (an MSI rolls the install back on a non-zero return),
/// writes diagnostics to stdout/stderr for the MSI log, and never prompts.
/// </summary>
internal static class InstallConfigurator
{
    private const string ConfigureVerb = "--configure";
    private const string ServerUrlOption = "--server-url";
    private const string EnrollmentTokenOption = "--enrollment-token";
    private const string AllowInsecureHttpOption = "--allow-insecure-http";

    /// <summary>Conventional process exit codes. Anything non-zero fails the MSI transaction.</summary>
    private const int ExitSuccess = 0;
    private const int ExitInvalidArguments = 1;
    private const int ExitFailed = 2;

    public static bool IsConfigureRequest(string[] args) =>
        args.Any(argument => string.Equals(argument, ConfigureVerb, StringComparison.OrdinalIgnoreCase));

    public static int Run(string[] args)
    {
        try
        {
            var serverUrl = ReadOption(args, ServerUrlOption);
            var enrollmentToken = ReadOption(args, EnrollmentTokenOption);
            var allowInsecureHttp = args.Any(a => string.Equals(a, AllowInsecureHttpOption, StringComparison.OrdinalIgnoreCase));

            if (string.IsNullOrWhiteSpace(serverUrl))
            {
                return Fail(ExitInvalidArguments, $"{ServerUrlOption} is required.");
            }

            if (string.IsNullOrWhiteSpace(enrollmentToken))
            {
                return Fail(ExitInvalidArguments, $"{EnrollmentTokenOption} is required.");
            }

            if (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var parsed))
            {
                return Fail(ExitInvalidArguments, $"'{serverUrl}' is not an absolute URL.");
            }

            if (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp)
            {
                return Fail(ExitInvalidArguments, $"'{serverUrl}' must be http or https.");
            }

            // Spec section 9 requires TLS. Refusing here rather than at first contact means a
            // misconfigured rollout fails at install time, on the machine being installed, rather
            // than silently sending telemetry in the clear until someone notices.
            if (parsed.Scheme != Uri.UriSchemeHttps && !allowInsecureHttp)
            {
                return Fail(
                    ExitInvalidArguments,
                    $"'{serverUrl}' is not HTTPS. Pass {AllowInsecureHttpOption} only for a local test server.");
            }

            ApplyDataDirectoryLayout();
            RegisterEventLogSources();

            new AgentConfiguration
            {
                ServerUrl = serverUrl,
                EnrollmentToken = enrollmentToken,
                AllowInsecureHttp = allowInsecureHttp
            }.Save();

            Console.Out.WriteLine($"Wrote {AgentPaths.ConfigPath} for {parsed.GetLeftPart(UriPartial.Authority)}.");

            if (allowInsecureHttp)
            {
                Console.Out.WriteLine("WARNING: insecure HTTP was permitted. This is for a test server only.");
            }

            return ExitSuccess;
        }
        catch (Exception ex)
        {
            // Every failure mode here is one an administrator has to act on - a denied ACL write,
            // a read-only ProgramData, a path made unavailable by policy - so the message matters
            // more than the stack, but the MSI log is the only place either will be seen.
            return Fail(ExitFailed, ex.ToString());
        }
    }

    /// <summary>
    /// Registers the Event Log sources for both processes.
    ///
    /// Done here because this is the only elevated moment in the agent's life. Creating a source
    /// writes under HKLM and takes administrator privileges; the service could do it as SYSTEM on
    /// first start, but the host runs as the logged-on employee and cannot.
    ///
    /// This does not prevent a crash - .NET degrades rather than failing, and "when an event source
    /// can't be created... event logs are disabled". It prevents something quieter and worse: the
    /// host silently losing its Event Log sink on every machine where the source was never
    /// registered, which is exactly the channel an administrator goes looking in when the
    /// user-session half misbehaves. The file sink keeps working either way.
    ///
    /// Creating them at install time also satisfies the documented latency rule: a source "should
    /// not be created and immediately used", and here nothing uses them until the service starts.
    ///
    /// A failure is reported but does not fail the install. Losing one of two log sinks is worth
    /// far less than a rolled-back deployment; the file sink under ProgramData still works, and it
    /// is the one an administrator is asked for anyway.
    /// </summary>
    private static void RegisterEventLogSources()
    {
        foreach (var source in new[] { AgentPaths.ServiceEventLogSource, AgentPaths.HostEventLogSource })
        {
            try
            {
                if (EventLog.SourceExists(source)) continue;

                EventLog.CreateEventSource(source, AgentPaths.EventLogName);
                Console.Out.WriteLine($"Registered Event Log source '{source}'.");
            }
            catch (Exception ex) when (ex is SecurityException or InvalidOperationException or ArgumentException or Win32Exception)
            {
                Console.Error.WriteLine(
                    $"WARNING: could not register Event Log source '{source}': {ex.Message}. " +
                    "The agent will still log to files under ProgramData.");
            }
        }
    }

    /// <summary>
    /// Creates the data directories and locks them down.
    ///
    /// Identities are resolved from <see cref="WellKnownSidType"/> rather than from names like
    /// "BUILTIN\Users". The names are localized - on a German or Japanese install they do not
    /// exist - and an installer that throws on a non-English workstation is an installer that
    /// cannot be shipped to one.
    /// </summary>
    private static void ApplyDataDirectoryLayout()
    {
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);

        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

        // The root holds the local telemetry database and the DPAPI-protected device key.
        // Inheritance is switched off and the inherited rules dropped, so a standard user cannot
        // read or tamper with collected data on their own machine.
        var rootSecurity = new DirectorySecurity();
        rootSecurity.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        rootSecurity.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        rootSecurity.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        CreateWithSecurity(AgentPaths.RootDirectory, rootSecurity);

        // The host runs as the logged-on employee and stages captures here before the service
        // uploads them, so this one subdirectory has to stay writable by users.
        var spoolSecurity = new DirectorySecurity();
        spoolSecurity.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.Modify, inherit, PropagationFlags.None, AccessControlType.Allow));
        CreateWithSecurity(AgentPaths.ScreenshotSpoolDirectory, spoolSecurity);

        // Same problem for logs, but Write rather than Modify on purpose: the host must create and
        // append to its own log file, while a standard user must not be able to delete or truncate
        // the agent's history. Ageing files out is RetentionWorker's job, running as SYSTEM.
        var logSecurity = new DirectorySecurity();
        logSecurity.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.Write | FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        CreateWithSecurity(AgentPaths.LogDirectory, logSecurity);
    }

    /// <summary>
    /// Creates a directory if it is missing and applies the access rules either way.
    ///
    /// Applied on every run rather than only at creation, because an upgrade over an installation
    /// whose ACLs were loosened by hand should end up correct rather than merely unchanged.
    /// </summary>
    private static void CreateWithSecurity(string path, DirectorySecurity security)
    {
        var directory = new DirectoryInfo(path);
        if (!directory.Exists) directory.Create();

        directory.SetAccessControl(security);
    }

    private static string? ReadOption(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }

        return null;
    }

    private static int Fail(int exitCode, string message)
    {
        Console.Error.WriteLine($"Agent configuration failed: {message}");
        return exitCode;
    }
}
