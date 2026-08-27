================================================================================
 Employee Monitor Agent - workstation deployment package
================================================================================

WHAT THIS IS
  A complete, self-contained copy of the agent. The two executables are already
  built and carry their own .NET runtime, so a workstation needs no .NET
  installation, no SDK, and no internet access to install.

  Nothing in this folder compiles anything. Installing only copies files,
  writes the configuration you type in, and registers a Windows service.

CONTENTS
  install.bat                   Start here. Double-click it.
  Install-Agent.ps1             The installer itself; install.bat calls it.
  EmployeeMonitor.Service.exe    The SYSTEM service.
  EmployeeMonitor.Host.exe       The per-user session process.
  appsettings.json              Logging configuration.
  README.txt                    This file.

BEFORE YOU START
  Have these two values ready, from the dashboard:
    1. The server address, e.g. monitoring.example.com
    2. The organization enrollment token, from Settings -> Organization

INSTALLING ON ONE WORKSTATION
  1. Copy this entire folder to the machine (a USB stick or a file share is
     fine). Copy the whole folder - install.bat alone will not work.
  2. Double-click install.bat.
  3. Approve the Windows administrator prompt.
  4. Choose [1] Install.
  5. Type the server address and the enrollment token when asked.

  The agent enrolls with the server within a minute and starts collecting at
  the next logon.

THE MENU
  [1] Install            Configure and start the agent.
  [2] Reinstall          Replace the files and settings, keep collected data.
  [3] Uninstall          Remove the agent, keep collected data.
  [4] Uninstall + purge  Remove the agent and delete all collected data.
  [5] Status             Show the service, the version, the server it points
                         at, whether it has enrolled, and what is queued.

  The agent also appears in Settings -> Apps -> Installed apps, and can be
  removed from there.

INSTALLING ACROSS THE FLEET
  Put this folder on a share and run, elevated, on each machine:

    powershell -NoProfile -ExecutionPolicy Bypass ^
      -File "\\fileserver\deploy\EmployeeMonitorAgent\Install-Agent.ps1" ^
      -Action Install ^
      -ServerUrl https://monitoring.example.com ^
      -EnrollmentToken <token>

  That form prompts for nothing and is what a GPO startup script or a remote
  management tool should call. Exit code 0 means success.

  install.bat also accepts one argument for the same purpose, and elevates
  itself first:  install.bat install | reinstall | uninstall |
                 uninstall-purge | status

A PLAIN-HTTP SERVER
  The installer requires an https:// address. A test server without TLS needs
  -AllowInsecureHttp on the command line, or the confirmation the menu shows
  after you enter an http:// address. Do not use it in production: telemetry,
  including screenshots, would travel unencrypted.

WHERE THINGS GO
  Program files      C:\Program Files\Employee Monitor
  Data and logs      C:\ProgramData\EmployeeMonitor
  Service name       EmployeeMonitorAgent

IF SOMETHING GOES WRONG
  Run install.bat and choose [5] Status first - it shows whether the service
  is running, whether the machine enrolled, and how much is queued locally.
  Then collect C:\ProgramData\EmployeeMonitor\logs.
