<#
.SYNOPSIS
    Installs the Workforce Agent (Agent.Host service + Agent.TrayHelper) on this machine.

.DESCRIPTION
    Run as Administrator on the target employee workstation, AFTER the device has already been
    registered with the backend and its one-time API key has been issued (see
    docs/it-admin-deployment-guide.md, sections 4-5). This script:
      1. Copies the published Agent.Host and Agent.TrayHelper output into Program Files.
      2. Points both processes at the backend and the shared data directory.
      3. Stores the device API key as a machine environment variable, which the Agent imports
         into its DPAPI-protected local credential store on first run (it is not needed again
         after that first run - see Agent.Core/Identity/DeviceEnrollmentBootstrapper.cs).
      4. Installs Agent.Host as a Windows Service ("WorkforceAgent"), set to start automatically.
      5. Adds a shortcut to Agent.TrayHelper in the all-users Startup folder, so the consent
         notice / interactive collectors start for whichever employee logs in.

.PARAMETER PublishSourceRoot
    Folder containing the published output. Must contain an "Agent.Host" subfolder and an
    "Agent.TrayHelper" subfolder - i.e. exactly what the two `dotnet publish` commands in the
    deployment guide produce.

.PARAMETER BackendBaseUrl
    The backend's base URL, e.g. https://monitoring.yourcompany.com/

.PARAMETER DeviceApiKey
    The one-time "rawApiKey" returned by POST /v1/dashboard/employees/devices when this device
    was registered. This script only uses it to set an environment variable - it is not written
    to any file by this script.

.EXAMPLE
    .\Install-Agent.ps1 -PublishSourceRoot C:\Deploy\WorkforceAgent -BackendBaseUrl "https://monitoring.yourcompany.com/" -DeviceApiKey "a1b2c3...64 hex chars"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $PublishSourceRoot,
    [Parameter(Mandatory)] [string] $BackendBaseUrl,
    [Parameter(Mandatory)] [string] $DeviceApiKey,
    [string] $InstallDir = "$env:ProgramFiles\WorkforceAgent",
    [string] $DataDirectory = 'C:\ProgramData\WorkforceAgent'
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'WorkforceAgent'

function Assert-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run from an elevated (Administrator) PowerShell session.'
    }
}

function Set-BackendConfig {
    param([string] $SettingsPath, [string] $BackendBaseUrl, [string] $DataDirectory)

    $json = Get-Content -Path $SettingsPath -Raw | ConvertFrom-Json
    $json.Agent.BackendBaseUrl = $BackendBaseUrl
    $json.Agent.DataDirectory = $DataDirectory
    ($json | ConvertTo-Json -Depth 10) | Set-Content -Path $SettingsPath -Encoding utf8
}

Assert-Admin

$hostSource = Join-Path $PublishSourceRoot 'Agent.Host'
$traySource = Join-Path $PublishSourceRoot 'Agent.TrayHelper'
foreach ($path in @($hostSource, $traySource)) {
    if (-not (Test-Path $path)) {
        throw "Expected published output at '$path'. Run 'dotnet publish' first - see docs/it-admin-deployment-guide.md section 6."
    }
}

$hostInstallDir = Join-Path $InstallDir 'Agent.Host'
$trayInstallDir = Join-Path $InstallDir 'Agent.TrayHelper'

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "Service '$ServiceName' already exists - stopping it before reinstalling ..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

Write-Host "Copying Agent.Host to $hostInstallDir ..."
New-Item -ItemType Directory -Force -Path $hostInstallDir | Out-Null
Copy-Item -Path (Join-Path $hostSource '*') -Destination $hostInstallDir -Recurse -Force

Write-Host "Copying Agent.TrayHelper to $trayInstallDir ..."
New-Item -ItemType Directory -Force -Path $trayInstallDir | Out-Null
Copy-Item -Path (Join-Path $traySource '*') -Destination $trayInstallDir -Recurse -Force

Write-Host 'Pointing both processes at the backend ...'
Set-BackendConfig -SettingsPath (Join-Path $hostInstallDir 'appsettings.json') -BackendBaseUrl $BackendBaseUrl -DataDirectory $DataDirectory
Set-BackendConfig -SettingsPath (Join-Path $trayInstallDir 'appsettings.json') -BackendBaseUrl $BackendBaseUrl -DataDirectory $DataDirectory

Write-Host 'Storing the device API key as a machine environment variable (imported and then no longer needed on next start) ...'
[Environment]::SetEnvironmentVariable('WORKFORCEAGENT_DEVICE_API_KEY', $DeviceApiKey, 'Machine')

Write-Host "Installing '$ServiceName' as a Windows Service (LocalSystem, starts automatically) ..."
$hostExe = Join-Path $hostInstallDir 'Agent.Host.exe'
New-Service -Name $ServiceName `
    -BinaryPathName $hostExe `
    -DisplayName 'Workforce Agent' `
    -Description 'Enterprise endpoint monitoring agent (attendance, activity, and policy compliance telemetry).' `
    -StartupType Automatic | Out-Null

Write-Host 'Configuring Agent.TrayHelper to launch for every user at logon ...'
$commonStartup = [Environment]::GetFolderPath('CommonStartup')
$shortcutPath = Join-Path $commonStartup 'Workforce Agent.lnk'
$trayExe = Join-Path $trayInstallDir 'Agent.TrayHelper.exe'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $trayExe
$shortcut.WorkingDirectory = $trayInstallDir
$shortcut.Description = 'Workforce Agent - monitoring notice and interactive collectors'
$shortcut.Save()

Write-Host "Starting the '$ServiceName' service ..."
Start-Service -Name $ServiceName

Write-Host ''
Write-Host 'Done. The Agent service is running.' -ForegroundColor Green
Write-Host 'The consent notice will appear the next time someone logs into this machine (Agent.TrayHelper starts from the all-users Startup folder).'
Write-Host "Logs: $DataDirectory\logs\"
