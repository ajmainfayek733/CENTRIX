using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Interop;

/// <summary>
/// Starts a process on the interactive user's desktop from a service running as SYSTEM in
/// session 0.
///
/// This is the crux of the split architecture. A service cannot simply Process.Start the host:
/// the child would inherit session 0, where there is no desktop, no foreground window and
/// nothing to screenshot. The sequence is:
///
///   WTSGetActiveConsoleSessionId  - which session is at the physical console
///   WTSQueryUserToken             - the logged-on user's primary token for that session
///   DuplicateTokenEx              - a primary token we are allowed to spawn with
///   CreateEnvironmentBlock        - the user's environment, not SYSTEM's
///   CreateProcessAsUser           - launch on winsta0\default
/// </summary>
public sealed partial class SessionLauncher(ILogger<SessionLauncher> logger)
{
    private readonly ILogger<SessionLauncher> _logger = logger;

    /// <summary>
    /// Launches <paramref name="executablePath"/> in the active console session.
    /// Returns the new process id, or null when nobody is logged on.
    /// </summary>
    public uint? LaunchInActiveSession(string executablePath, string? arguments = null)
    {
        var sessionId = WTSGetActiveConsoleSessionId();

        // 0xFFFFFFFF means there is no console session attached - the machine is at the
        // logon screen or between sessions. Not an error; the supervisor retries.
        if (sessionId == 0xFFFFFFFF)
        {
            _logger.LogDebug("No active console session; nothing to launch into");
            return null;
        }

        if (!WTSQueryUserToken(sessionId, out var userToken))
        {
            // ERROR_NO_TOKEN here just means no interactive user in that session yet.
            var error = Marshal.GetLastWin32Error();
            _logger.LogDebug("WTSQueryUserToken failed for session {Session} (win32 {Error})", sessionId, error);
            return null;
        }

        var primaryToken = IntPtr.Zero;
        var environment = IntPtr.Zero;

        try
        {
            if (!DuplicateTokenEx(
                    userToken,
                    TOKEN_ALL_ACCESS,
                    IntPtr.Zero,
                    SecurityImpersonationLevel.SecurityIdentification,
                    TokenType.TokenPrimary,
                    out primaryToken))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed");
            }

            // Without the user's own environment block the host gets SYSTEM's %APPDATA% and
            // %TEMP%, which would put per-user files in the wrong place.
            if (!CreateEnvironmentBlock(out environment, primaryToken, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateEnvironmentBlock failed");
            }

            var startupInfo = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                // The interactive window station and desktop. Anything else gives a process
                // that can run but cannot see or draw on the user's screen.
                lpDesktop = @"winsta0\default"
            };

            var commandLine = arguments is null
                ? $"\"{executablePath}\""
                : $"\"{executablePath}\" {arguments}";

            var created = CreateProcessAsUser(
                primaryToken,
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment,
                null,
                ref startupInfo,
                out var processInfo);

            if (!created)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed");
            }

            // We only need the pid to supervise; the handles would otherwise leak.
            CloseHandle(processInfo.hProcess);
            CloseHandle(processInfo.hThread);

            _logger.LogInformation(
                "Launched {Executable} as pid {Pid} in session {Session}",
                Path.GetFileName(executablePath), processInfo.dwProcessId, sessionId);

            return processInfo.dwProcessId;
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            CloseHandle(userToken);
        }
    }

    // -- Win32 -------------------------------------------------------------------

    private const uint TOKEN_ALL_ACCESS = 0xF01FF;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;

    private enum SecurityImpersonationLevel
    {
        SecurityAnonymous,
        SecurityIdentification,
        SecurityImpersonation,
        SecurityDelegation
    }

    private enum TokenType
    {
        TokenPrimary = 1,
        TokenImpersonation
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [LibraryImport("kernel32.dll")]
    private static partial uint WTSGetActiveConsoleSessionId();

    [LibraryImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DuplicateTokenEx(
        IntPtr existingToken,
        uint desiredAccess,
        IntPtr tokenAttributes,
        SecurityImpersonationLevel impersonationLevel,
        TokenType tokenType,
        out IntPtr newToken);

    [LibraryImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreateEnvironmentBlock(
        out IntPtr environment,
        IntPtr token,
        [MarshalAs(UnmanagedType.Bool)] bool inherit);

    [LibraryImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DestroyEnvironmentBlock(IntPtr environment);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string? applicationName,
        string? commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
}
