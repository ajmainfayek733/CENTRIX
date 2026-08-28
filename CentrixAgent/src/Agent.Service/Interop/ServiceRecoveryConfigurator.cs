using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace Agent.Service.Interop;

internal static partial class ServiceRecoveryConfigurator
{
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryConfig = 0x0001;
    private const uint ServiceChangeConfig = 0x0002;
    private const uint ServiceConfigFailureActionsFlag = 4;
    private const string ServiceName = "CentrixAgent";

    public static void TryEnableNonCrashRecovery(ILogger logger)
    {
        var manager = OpenScManager(null, null, ScManagerConnect);
        if (manager == IntPtr.Zero)
        {
            logger.LogWarning("Could not open the Service Control Manager to enable service recovery: {Error}", Marshal.GetLastWin32Error());
            return;
        }

        try
        {
            var service = OpenService(manager, ServiceName, ServiceQueryConfig | ServiceChangeConfig);
            if (service == IntPtr.Zero)
            {
                logger.LogWarning("Could not open {ServiceName} to enable non-crash recovery: {Error}", ServiceName, Marshal.GetLastWin32Error());
                return;
            }

            try
            {
                var flag = new ServiceFailureActionsFlag { FailureActionsOnNonCrashFailures = 1 };
                if (!ChangeServiceConfig2(service, ServiceConfigFailureActionsFlag, ref flag))
                {
                    logger.LogWarning("Could not enable non-crash recovery for {ServiceName}: {Error}", ServiceName, Marshal.GetLastWin32Error());
                    return;
                }

                logger.LogInformation("Service recovery is enabled for unexpected {ServiceName} termination", ServiceName);
            }
            finally
            {
                CloseServiceHandle(service);
            }
        }
        finally
        {
            CloseServiceHandle(manager);
        }
    }

    [LibraryImport("advapi32.dll", EntryPoint = "OpenSCManagerW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial IntPtr OpenScManager(string? machineName, string? databaseName, uint desiredAccess);

    [LibraryImport("advapi32.dll", EntryPoint = "OpenServiceW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial IntPtr OpenService(IntPtr manager, string serviceName, uint desiredAccess);

    [LibraryImport("advapi32.dll", EntryPoint = "ChangeServiceConfig2W", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ChangeServiceConfig2(IntPtr service, uint infoLevel, ref ServiceFailureActionsFlag data);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseServiceHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceFailureActionsFlag
    {
        public int FailureActionsOnNonCrashFailures;
    }
}
