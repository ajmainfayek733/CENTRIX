<#
.SYNOPSIS
    Publishes, installs, and manages the Employee Monitor agent on a workstation.

.DESCRIPTION
    Covers the deployment steps in spec section 11: a scripted install that can be run
    unattended across the fleet, a config file written at install time carrying the server
    address and enrollment token, and a documented uninstall/rollback path.

    Must be run elevated: it registers a Windows service and writes under ProgramData.

.PARAMETER Action
    Publish   - build both executables self-contained into .\artifacts\agent
    Install   - publish, copy to Program Files, write config, register and start the service
    Uninstall - stop and remove the service, and optionally delete collected data
    Status    - show the service state and what the agent has queued locally

.PARAMETER ServerUrl
    Base URL of the monitoring server, e.g. https://monitoring.example.com
    Required for Install.

.PARAMETER EnrollmentToken
    Org enrollment token from the dashboard (Settings -> Organization). Required for Install.
    Traded once for a per-device API key; it is not itself a telemetry credential.

.PARAMETER AllowInsecureHttp
    Permit a plain-HTTP ServerUrl. For a local test server only — spec section 9 requires TLS.

.PARAMETER PurgeData
    With Uninstall, also delete the local database, screenshot spool and stored credential.

.EXAMPLE
    .\Deploy-Agent.ps1 -Action Install -ServerUrl https://monitoring.example.com -EnrollmentToken abc123...

.EXAMPLE
    # Unattended rollout, e.g. from a GPO startup script
    .\Deploy-Agent.ps1 -Action Install -ServerUrl https://monitoring.example.com -EnrollmentToken $env:ENROLL_TOKEN
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Publish', 'Install', 'Uninstall', 'Status')]
    [string]$Action,

    [string]$ServerUrl,
    [string]$EnrollmentToken,
    [switch]$AllowInsecureHttp,
    [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

$ServiceName  = 'EmployeeMonitorAgent'
$DisplayName  = 'Employee Monitor Agent'
$InstallDir   = Join-Path $env:ProgramFiles 'Employee Monitor'
$DataDir      = Join-Path $env:ProgramData 'EmployeeMonitor'
$RepoRoot     = Split-Path -Parent $PSScriptRoot
$ArtifactDir  = Join-Path $RepoRoot 'artifacts\agent'

function Assert-Elevated {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run from an elevated PowerShell session.'
    }
}

function Invoke-Publish {
    Write-Host 'Publishing agent (self-contained, win-x64)...' -ForegroundColor Cyan

    # Both executables publish into the same folder on purpose: HostSupervisorWorker resolves
    # EmployeeMonitor.Host.exe relative to the service's own directory.
    dotnet publish (Join-Path $RepoRoot 'src\Agent.Service\Agent.Service.csproj') -c Release -o $ArtifactDir --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Service publish failed.' }

    dotnet publish (Join-Path $RepoRoot 'src\Agent.Host\Agent.Host.csproj') -c Release -o $ArtifactDir --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Host publish failed.' }

    Write-Host "Published to $ArtifactDir" -ForegroundColor Green
}

function Write-AgentConfig {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

    # The data directory holds the local telemetry database and the DPAPI-protected device
    # key. Inheritance is disabled and Users are dropped so a standard user cannot read or
    # tamper with collected data on their own machine.
    $acl = Get-Acl $DataDir
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    foreach ($principal in 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators') {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -Path $DataDir -AclObject $acl

    # The host writes screenshots here before the service uploads them, and the host runs as
    # the logged-on user — so this one subdirectory has to stay writable by users.
    $spool = Join-Path $DataDir 'screenshots'
    if (-not (Test-Path $spool)) { New-Item -ItemType Directory -Path $spool -Force | Out-Null }
    $spoolAcl = Get-Acl $spool
    $spoolRule = [Security.AccessControl.FileSystemAccessRule]::new(
        'BUILTIN\Users', 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $spoolAcl.AddAccessRule($spoolRule)
    Set-Acl -Path $spool -AclObject $spoolAcl

    # Same problem for logs: the host runs as the employee and writes host-s<session>-<date>.log
    # here. Granted 'Write' rather than 'Modify' on purpose — a standard user can create and
    # append to their own log file but cannot delete or truncate the agent's history. Ageing
    # files out is the service's job (RetentionWorker), which runs as SYSTEM.
    $logs = Join-Path $DataDir 'logs'
    if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs -Force | Out-Null }
    $logsAcl = Get-Acl $logs
    $logsRule = [Security.AccessControl.FileSystemAccessRule]::new(
        'BUILTIN\Users', 'Write, ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $logsAcl.AddAccessRule($logsRule)
    Set-Acl -Path $logs -AclObject $logsAcl

    $config = [ordered]@{
        serverUrl         = $ServerUrl
        enrollmentToken   = $EnrollmentToken
        allowInsecureHttp = [bool]$AllowInsecureHttp
    }

    $configPath = Join-Path $DataDir 'agent.config.json'
    $config | ConvertTo-Json | Out-File -FilePath $configPath -Encoding utf8 -Force
    Write-Host "Wrote $configPath" -ForegroundColor Green
}

function Invoke-Install {
    Assert-Elevated

    if (-not $ServerUrl)       { throw 'Install requires -ServerUrl.' }
    if (-not $EnrollmentToken) { throw 'Install requires -EnrollmentToken.' }

    if ($ServerUrl -notmatch '^https://' -and -not $AllowInsecureHttp) {
        throw "ServerUrl must be HTTPS (spec section 9). Pass -AllowInsecureHttp only for a local test server."
    }

    Invoke-Publish

    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host 'Stopping the existing service for upgrade...' -ForegroundColor Yellow
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        # The SCM releases the executable lock asynchronously; copying too early fails.
        Start-Sleep -Seconds 2
    }

    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    Copy-Item -Path (Join-Path $ArtifactDir '*') -Destination $InstallDir -Recurse -Force

    Write-AgentConfig

    $binaryPath = Join-Path $InstallDir 'EmployeeMonitor.Service.exe'

    if (-not $existing) {
        Write-Host 'Registering the service...' -ForegroundColor Cyan
        New-Service -Name $ServiceName `
                    -BinaryPathName "`"$binaryPath`"" `
                    -DisplayName $DisplayName `
                    -Description 'Collects workplace productivity telemetry under company monitoring policy. See the notice in the system tray.' `
                    -StartupType Automatic | Out-Null

        # Spec section 10: the agent must auto-recover if it crashes. Restart after 5s on the
        # first two failures, 60s thereafter, and reset the counter daily.
        & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null
    }

    Start-Service -Name $ServiceName
    Write-Host "$DisplayName installed and started." -ForegroundColor Green
    Write-Host 'The agent will enroll with the server and begin collecting on the next logon.' -ForegroundColor Green
}

function Invoke-Uninstall {
    Assert-Elevated

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host 'Stopping and removing the service...' -ForegroundColor Cyan
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        & sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    }
    else {
        Write-Host 'Service is not installed.' -ForegroundColor Yellow
    }

    # The service supervises the host, so the host has to be stopped explicitly — otherwise
    # it keeps running in the user's session until logoff.
    Get-Process -Name 'EmployeeMonitor.Host' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue

    if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }

    if ($PurgeData) {
        if (Test-Path $DataDir) { Remove-Item -Path $DataDir -Recurse -Force }
        Write-Host 'Collected data and stored credentials deleted.' -ForegroundColor Green
    }
    else {
        Write-Host "Collected data left in $DataDir. Re-run with -PurgeData to remove it." -ForegroundColor Yellow
    }

    Write-Host 'Uninstall complete.' -ForegroundColor Green
}

function Invoke-Status {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host "Service : $($service.Status)" -ForegroundColor Cyan
    }
    else {
        Write-Host 'Service : not installed' -ForegroundColor Yellow
    }

    # Not $host — that is a reserved PowerShell automatic variable and assigning to it throws.
    $hostProcess = Get-Process -Name 'EmployeeMonitor.Host' -ErrorAction SilentlyContinue
    Write-Host "Host    : $(if ($hostProcess) { "running (pid $($hostProcess.Id))" } else { 'not running' })" -ForegroundColor Cyan

    $configPath = Join-Path $DataDir 'agent.config.json'
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        Write-Host "Server  : $($config.serverUrl)" -ForegroundColor Cyan
    }

    $dbPath = Join-Path $DataDir 'agent.db'
    if (Test-Path $dbPath) {
        $size = [math]::Round((Get-Item $dbPath).Length / 1KB, 1)
        Write-Host "Local DB: $dbPath ($size KB)" -ForegroundColor Cyan
    }

    $credPath = Join-Path $DataDir 'device.key'
    Write-Host "Enrolled: $(if (Test-Path $credPath) { 'yes' } else { 'no' })" -ForegroundColor Cyan
}

switch ($Action) {
    'Publish'   { Invoke-Publish }
    'Install'   { Invoke-Install }
    'Uninstall' { Invoke-Uninstall }
    'Status'    { Invoke-Status }
}
