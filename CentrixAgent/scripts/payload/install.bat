@echo off
rem ============================================================================
rem  CENTRIX Agent - workstation installer
rem
rem  Ships inside the deployment bundle produced by
rem  scripts\Deploy-Agent.ps1 -Action Bundle. The bundle carries the already
rem  published, self-contained executables, so this script never builds
rem  anything and the target workstation needs no .NET runtime and no SDK.
rem
rem  Double-click it for a menu, or drive it unattended with one argument:
rem      install.bat install
rem      install.bat clean-install
rem      install.bat reinstall
rem      install.bat uninstall
rem      install.bat uninstall-purge
rem      install.bat status
rem
rem  Unattended installs still need the server URL and enrollment token, so
rem  pass them through the environment (see :run_action below) or call
rem  Install-Agent.ps1 directly with -ServerUrl and -EnrollmentToken.
rem ============================================================================

setlocal EnableExtensions

rem Delayed expansion stays OFF on purpose: an enrollment token containing '!'
rem would be silently mangled by it.

set "PRODUCT_NAME=CENTRIX Agent"
set "INSTALL_SCRIPT=%~dp0Install-Agent.ps1"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "SELF=%~f0"
set "REQUESTED_ACTION=%~1"

set "EXIT_OK=0"
set "EXIT_USAGE=1"
set "EXIT_MISSING_PAYLOAD=2"
set "EXIT_FAILED=3"

title %PRODUCT_NAME% Setup

if not exist "%INSTALL_SCRIPT%" (
    echo.
    echo   ERROR: Install-Agent.ps1 was not found next to this file.
    echo   Copy the whole bundle folder to the workstation, not just install.bat.
    echo.
    pause
    exit /b %EXIT_MISSING_PAYLOAD%
)

if not exist "%POWERSHELL%" (
    echo.
    echo   ERROR: Windows PowerShell was not found at
    echo   %POWERSHELL%
    echo.
    pause
    exit /b %EXIT_MISSING_PAYLOAD%
)

rem ---------------------------------------------------------------------------
rem  Elevation. fltmc is the check rather than "net session" because it does not
rem  depend on the Server service being started, and rather than "openfiles"
rem  because that one is slow. It fails with a non-zero exit code for a
rem  non-administrator and succeeds for an administrator.
rem ---------------------------------------------------------------------------
fltmc >nul 2>&1
if not errorlevel 1 goto :elevated

echo.
echo   %PRODUCT_NAME% Setup
echo   ----------------------------------------------------------------
echo   This installer registers a Windows service and writes under
echo   Program Files, so it must run as an administrator.
echo.
echo   Windows will now ask you to confirm elevation.
echo.
pause

if defined REQUESTED_ACTION (
    "%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:SELF -ArgumentList $env:REQUESTED_ACTION -Verb RunAs"
) else (
    "%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:SELF -Verb RunAs"
)

if errorlevel 1 (
    echo.
    echo   Elevation was refused or cancelled. Nothing has been changed.
    echo.
    pause
    exit /b %EXIT_FAILED%
)

rem The elevated copy owns the rest of the work and runs in its own window.
exit /b %EXIT_OK%

:elevated
if defined REQUESTED_ACTION goto :dispatch_argument
goto :menu

rem ---------------------------------------------------------------------------
rem  Unattended entry point.
rem ---------------------------------------------------------------------------
rem  Each branch is a parenthesised block, not a chain of "&"-separated commands: cmd applies
rem  "if" only to the first command of such a chain and runs the rest unconditionally.
:dispatch_argument
set "PAUSE_WHEN_DONE="

if /i "%REQUESTED_ACTION%"=="install" (
    set "ACTION=Install"
    set "ARGS=-Interactive"
    goto :run_action
)
if /i "%REQUESTED_ACTION%"=="clean-install" (
    set "ACTION=Install"
    set "ARGS=-Interactive -CleanInstall"
    goto :run_action
)
if /i "%REQUESTED_ACTION%"=="reinstall" (
    set "ACTION=Reinstall"
    set "ARGS=-Interactive"
    goto :run_action
)
if /i "%REQUESTED_ACTION%"=="uninstall" (
    set "ACTION=Uninstall"
    set "ARGS="
    goto :run_action
)
if /i "%REQUESTED_ACTION%"=="uninstall-purge" (
    set "ACTION=Uninstall"
    set "ARGS=-PurgeData"
    goto :run_action
)
if /i "%REQUESTED_ACTION%"=="status" (
    set "ACTION=Status"
    set "ARGS="
    goto :run_action
)

echo.
echo   ERROR: unknown action "%REQUESTED_ACTION%".
echo   Valid actions: install, clean-install, reinstall, uninstall, uninstall-purge, status
echo.
pause
exit /b %EXIT_USAGE%

rem ---------------------------------------------------------------------------
rem  Interactive menu.
rem ---------------------------------------------------------------------------
:menu
set "PAUSE_WHEN_DONE=1"
cls
echo.
echo   ================================================================
echo     %PRODUCT_NAME% Setup
echo   ================================================================
echo.
echo     Running as administrator.
echo     Package folder: %~dp0
echo.
echo     [1]  Install            - configure and start the agent, keep existing data
echo     [2]  Clean install      - remove existing data, then install
echo     [3]  Reinstall          - replace the files, keep collected data
echo     [4]  Uninstall          - remove the agent, keep collected data
echo     [5]  Uninstall + purge  - remove the agent and delete all data
echo     [6]  Status             - show what is installed and enrolled
echo     [Q]  Quit
echo.

choice /c 123456Q /n /m "   Select an option: "
set "MENU_CHOICE=%errorlevel%"

if "%MENU_CHOICE%"=="7" goto :quit
if "%MENU_CHOICE%"=="6" (
    set "ACTION=Status"
    set "ARGS="
    goto :run_action
)
if "%MENU_CHOICE%"=="5" (
    set "ACTION=Uninstall"
    set "ARGS=-PurgeData"
    goto :confirm_purge
)
if "%MENU_CHOICE%"=="4" (
    set "ACTION=Uninstall"
    set "ARGS="
    goto :run_action
)
if "%MENU_CHOICE%"=="3" (
    set "ACTION=Reinstall"
    set "ARGS=-Interactive"
    goto :run_action
)
if "%MENU_CHOICE%"=="2" (
    set "ACTION=Install"
    set "ARGS=-Interactive -CleanInstall"
    goto :confirm_clean_install
)
if "%MENU_CHOICE%"=="1" (
    set "ACTION=Install"
    set "ARGS=-Interactive"
    goto :run_action
)
goto :menu

:confirm_clean_install
echo.
echo   This deletes the local telemetry database, screenshot spool,
echo   agent logs and stored device credential before installation.
choice /c YN /n /m "   Delete all existing data? [Y/N] "
if errorlevel 2 goto :menu
goto :run_action

:confirm_purge
echo.
echo   This deletes the local telemetry database, the screenshot spool,
echo   the agent logs and the stored device credential. Telemetry that has
echo   not been uploaded yet will be lost and cannot be recovered.
echo.
choice /c YN /n /m "   Delete all collected data? [Y/N] "
if errorlevel 2 goto :menu
goto :run_action

rem ---------------------------------------------------------------------------
rem  Hand off to PowerShell, which owns every decision that touches the machine.
rem  The prompts for server URL, enrollment token and insecure HTTP live there
rem  too: cmd's "set /p" mangles '&', '^' and '%' in a pasted token, and
rem  PowerShell's Read-Host does not.
rem ---------------------------------------------------------------------------
:run_action
echo.
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_SCRIPT%" -Action %ACTION% %ARGS%
set "SCRIPT_EXIT=%errorlevel%"

if not "%SCRIPT_EXIT%"=="0" (
    echo.
    echo   %ACTION% failed with exit code %SCRIPT_EXIT%.
)

if defined PAUSE_WHEN_DONE (
    echo.
    pause
    goto :menu
)

exit /b %SCRIPT_EXIT%

:quit
endlocal
exit /b 0
