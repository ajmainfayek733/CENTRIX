<#
.SYNOPSIS
    Removes the Workforce Agent from this machine.

.PARAMETER Purge
    Also deletes locally buffered data (C:\ProgramData\WorkforceAgent, including the offline
    outbox and the DPAPI-protected device credential) and clears the machine-scoped device API
    key environment variable. Without -Purge, this data is left in place - re-running
    Install-Agent.ps1 for the same device will pick the existing credential/outbox back up.
    Use -Purge with care: any locally buffered events not yet synced to the backend are lost,
    and the device will need to be re-provisioned (or, if you want to keep using the same
    device row, the environment variable set again) before it can talk to the backend again.

.EXAMPLE
    .\Uninstall-Agent.ps1
.EXAMPLE
    .\Uninstall-Agent.ps1 -Purge
#>
[CmdletBinding()]
param(
    [string] $InstallDir = "$env:ProgramFiles\WorkforceAgent",
    [string] $DataDirectory = 'C:\ProgramData\WorkforceAgent',
    [switch] $Purge
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'WorkforceAgent'

function Assert-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run from an elevated (Administrator) PowerShell session.'
    }
}

Assert-Admin

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping and removing the '$ServiceName' service ..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
}
else {
    Write-Host "Service '$ServiceName' not found - skipping."
}

Get-Process -Name 'Agent.TrayHelper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$commonStartup = [Environment]::GetFolderPath('CommonStartup')
$shortcutPath = Join-Path $commonStartup 'Workforce Agent.lnk'
if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
}

if (Test-Path $InstallDir) {
    Write-Host "Removing installed files at $InstallDir ..."
    Remove-Item $InstallDir -Recurse -Force
}

if ($Purge) {
    Write-Host 'Purging local data and the stored device credential ...' -ForegroundColor Yellow
    [Environment]::SetEnvironmentVariable('WORKFORCEAGENT_DEVICE_API_KEY', $null, 'Machine')
    if (Test-Path $DataDirectory) {
        Remove-Item $DataDirectory -Recurse -Force
    }
}
else {
    Write-Host "Local data left in place at $DataDirectory (re-running Install-Agent.ps1 will resume using the existing offline buffer and device credential). Use -Purge to remove it."
}

Write-Host 'Workforce Agent removed.' -ForegroundColor Green
