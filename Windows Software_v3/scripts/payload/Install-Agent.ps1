<#
.SYNOPSIS
    Installs, upgrades, removes and inspects the Employee Monitor agent on one workstation.

.DESCRIPTION
    The machine-side half of the deployment story. It ships inside the bundle produced by
    scripts\Deploy-Agent.ps1 -Action Bundle, alongside the two already published executables,
    and it never compiles anything: the agent publishes self-contained and single-file, so a
    target workstation needs neither the .NET SDK nor the .NET runtime.

    Deploy-Agent.ps1 calls this same script for its Install/Uninstall/Status actions, so a
    developer machine and a fleet workstation run one implementation, not two.

    Everything that defines the on-disk layout - ProgramData directories, their ACLs, the Event
    Log sources and agent.config.json - is delegated to the agent's own --configure step. This
    script owns only what is outside the agent: the Program Files copy, the service registration,
    and the Add/Remove Programs entry.

    Must be run elevated. install.bat handles that; if you call this script directly, start it
    from an elevated session.

.PARAMETER Action
    Install   - copy the payload, write the configuration, register and start the service
    Reinstall - remove the current installation (keeping collected data) and install again
    Uninstall - stop and remove the service and the installed files
    Status    - report the service, the host process, the configuration and the local database

.PARAMETER ServerUrl
    Base URL of the monitoring server, e.g. https://monitoring.example.com
    A bare host name is accepted and normalised to https://. Required for Install and Reinstall
    unless -Interactive is set, in which case it is prompted for.

.PARAMETER EnrollmentToken
    Org enrollment token from the dashboard (Settings -> Organization). Traded once for a
    per-device API key; it is not itself a telemetry credential.

.PARAMETER AllowInsecureHttp
    Permit a plain-HTTP ServerUrl. For a local test server only - spec section 9 requires TLS.

.PARAMETER PurgeData
    With Uninstall, also delete the local database, screenshot spool, logs and stored credential.

.PARAMETER SourceDir
    Directory holding the published executables. Defaults to this script's own folder, which is
    what the bundle layout produces.

.PARAMETER Interactive
    Prompt for anything required and not supplied. Set by install.bat's menu.

.EXAMPLE
    .\Install-Agent.ps1 -Action Install -ServerUrl https://monitoring.example.com -EnrollmentToken abc123

.EXAMPLE
    # Unattended rollout from a GPO startup script, against a copy of the bundle on a share
    \\fileserver\deploy\EmployeeMonitorAgent\Install-Agent.ps1 -Action Install `
        -ServerUrl https://monitoring.example.com -EnrollmentToken $env:ENROLL_TOKEN
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Reinstall', 'Uninstall', 'Status')]
    [string]$Action = 'Install',

    [string]$ServerUrl,
    [string]$EnrollmentToken,
    [switch]$AllowInsecureHttp,
    [switch]$PurgeData,
    [string]$SourceDir,
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'

# --- Identity ---------------------------------------------------------------------------------
$ServiceName      = 'EmployeeMonitorAgent'
$DisplayName      = 'Employee Monitor Agent'
$Publisher        = 'Employee Monitor'
$ServiceExeName   = 'EmployeeMonitor.Service.exe'
$HostExeName      = 'EmployeeMonitor.Host.exe'
$HostProcessName  = 'EmployeeMonitor.Host'
$InstallerBatName = 'install.bat'
$InstallerPs1Name = 'Install-Agent.ps1'

$ServiceDescription = 'Collects workplace productivity telemetry under company monitoring policy. See the notice in the system tray.'

# --- Locations --------------------------------------------------------------------------------
$InstallDir      = Join-Path $env:ProgramFiles 'Employee Monitor'
$DataDir         = Join-Path $env:ProgramData 'EmployeeMonitor'
$ScreenshotDir   = Join-Path $DataDir 'screenshots'
$LogDir          = Join-Path $DataDir 'logs'
$ConfigFileName  = 'agent.config.json'
$DatabaseFileName = 'agent.db'
$CredentialFileName = 'device.key'
$UninstallKey    = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$ServiceName"

# --- Behaviour constants ----------------------------------------------------------------------
# The SCM releases the executable lock asynchronously, so a copy immediately after Stop-Service
# fails with a sharing violation. These bound the wait rather than sleeping a fixed guess.
$ServiceStopTimeoutSeconds = 30
$ServiceStopPollMilliseconds = 250
$FileLockRetryCount = 20
$FileLockRetryMilliseconds = 500

# Spec section 10: the agent must auto-recover if it crashes. Restart after 5s on the first two
# failures, 60s thereafter, and reset the failure count daily.
$FailureResetSeconds = 86400
$FailureActions = 'restart/5000/restart/5000/restart/60000'

$BytesPerKilobyte = 1KB

# Files that are build output or developer-only settings and must not reach a workstation.
$ExcludedPayloadPatterns = @('*.pdb', 'appsettings.Development.json')

# --- Exit codes -------------------------------------------------------------------------------
$ExitSuccess         = 0
$ExitNotElevated     = 1
$ExitInvalidArgument = 2
$ExitMissingPayload  = 3
$ExitFailed          = 4

$HttpsScheme = 'https'
$HttpScheme  = 'http'

function Write-Step   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Ok     { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn   { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }
function Write-Failure{ param([string]$Message) Write-Host "  $Message" -ForegroundColor Red }

function Test-Elevated {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
.SYNOPSIS
    Resolves the folder holding the published executables and verifies both are present.
#>
function Resolve-PayloadDirectory {
    $candidate = if ($SourceDir) { $SourceDir } else { $PSScriptRoot }

    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "Payload directory '$candidate' does not exist."
    }

    $resolved = (Resolve-Path -LiteralPath $candidate).ProviderPath

    foreach ($required in @($ServiceExeName, $HostExeName)) {
        if (-not (Test-Path -LiteralPath (Join-Path $resolved $required))) {
            throw "'$required' is missing from '$resolved'. Copy the complete bundle folder, not just install.bat."
        }
    }

    # Installing a directory over itself would delete the payload mid-copy.
    if ($resolved.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) {
        throw "The payload is already in the install location ('$InstallDir'). Run install.bat from the bundle folder instead."
    }

    return $resolved
}

<#
.SYNOPSIS
    Reads the agent version out of the published executable.
.DESCRIPTION
    Taken from the binary rather than from a version file shipped beside it, so the number in
    Add/Remove Programs cannot disagree with the code that is actually installed.
#>
function Get-PayloadVersion {
    param([Parameter(Mandatory)][string]$ServiceExePath)

    $version = (Get-Item -LiteralPath $ServiceExePath).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "'$ServiceExePath' carries no product version. The payload is not a published agent build."
    }

    # A published apphost can carry SemVer build metadata ("3.2.0+abc1234"); the registry wants
    # the plain version.
    return ($version -split '\+')[0].Trim()
}

function Get-PayloadFile {
    param([Parameter(Mandatory)][string]$Directory)

    return Get-ChildItem -LiteralPath $Directory -File | Where-Object {
        $name = $_.Name
        -not ($ExcludedPayloadPatterns | Where-Object { $name -like $_ })
    }
}

<#
.SYNOPSIS
    Normalises what an administrator typed into an absolute URL.
.DESCRIPTION
    "monitoring.example.com" is what people write when asked for a domain, and silently rejecting
    it as "not an absolute URL" is a bad first impression. A scheme-less value becomes HTTPS,
    which is also the secure default the spec requires.
#>
function ConvertTo-ServerUrl {
    param([Parameter(Mandatory)][string]$Value)

    $trimmed = $Value.Trim().TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($trimmed)) { return $null }

    if ($trimmed -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        $trimmed = "$($HttpsScheme)://$trimmed"
    }

    return $trimmed
}

function Assert-ServerUrl {
    param(
        [Parameter(Mandatory)][string]$Url,
        [bool]$InsecureAllowed
    )

    $parsed = $null
    if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsed)) {
        throw "'$Url' is not a valid server address."
    }

    if ($parsed.Scheme -ne $HttpsScheme -and $parsed.Scheme -ne $HttpScheme) {
        throw "'$Url' must be an http or https address."
    }

    # Refused here as well as in the agent's own configure step, so an interactive operator is
    # corrected before any file is copied rather than after.
    if ($parsed.Scheme -ne $HttpsScheme -and -not $InsecureAllowed) {
        throw "'$Url' is not HTTPS (spec section 9). Choose 'yes' at the insecure-HTTP prompt, or pass -AllowInsecureHttp, only for a local test server."
    }
}

<#
.SYNOPSIS
    Collects the three install-time settings, prompting for whatever was not supplied.
#>
function Read-InstallSettings {
    $url = $ServerUrl
    $token = $EnrollmentToken
    $insecure = [bool]$AllowInsecureHttp

    if ($Interactive) {
        Write-Host ''
        Write-Host '  Server details' -ForegroundColor White
        Write-Host '  ----------------------------------------------------------------' -ForegroundColor DarkGray
    }

    while ([string]::IsNullOrWhiteSpace($url)) {
        if (-not $Interactive) { throw 'Install requires -ServerUrl.' }
        $url = Read-Host '  Server domain or URL (e.g. monitoring.example.com)'
    }

    $url = ConvertTo-ServerUrl -Value $url

    while ([string]::IsNullOrWhiteSpace($token)) {
        if (-not $Interactive) { throw 'Install requires -EnrollmentToken.' }
        $token = Read-Host '  Enrollment token (dashboard: Settings -> Organization)'
    }
    $token = $token.Trim()

    # Only meaningful for a plain-HTTP address, so it is only asked about for one. Asking after an
    # https:// answer would invite an operator to turn off a protection they are already getting.
    if ($url -like "$($HttpScheme)://*" -and -not $insecure -and $Interactive) {
        Write-Host ''
        Write-Warn 'That address is plain HTTP. Telemetry, including screenshots, would travel unencrypted.'
        $answer = Read-Host '  Allow insecure HTTP anyway? Test servers only [y/N]'
        $insecure = $answer.Trim() -in @('y', 'Y', 'yes', 'Yes', 'YES')
    }

    Assert-ServerUrl -Url $url -InsecureAllowed $insecure

    return [pscustomobject]@{
        ServerUrl         = $url
        EnrollmentToken   = $token
        AllowInsecureHttp = $insecure
    }
}

function Get-AgentService {
    return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

<#
.SYNOPSIS
    Stops the service and the user-session host, and waits for the executables to unlock.
.DESCRIPTION
    The service supervises the host, so the host has to be stopped explicitly - otherwise it keeps
    running in the employee's session until logoff and holds its own executable open.

    Stop-Process only signals termination; it returns before Windows has torn the process down and
    released its image. Deleting or overwriting the host executable in that window fails with
    "Access is denied" (an UnauthorizedAccessException, not a sharing violation), which is exactly
    the uninstall failure this waits out with Wait-Process.
#>
function Stop-AgentProcess {
    $service = Get-AgentService
    if ($service -and $service.Status -ne 'Stopped') {
        Write-Step 'Stopping the service...'
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue

        $deadline = (Get-Date).AddSeconds($ServiceStopTimeoutSeconds)
        while ((Get-Date) -lt $deadline) {
            $service.Refresh()
            if ($service.Status -eq 'Stopped') { break }
            Start-Sleep -Milliseconds $ServiceStopPollMilliseconds
        }

        if ($service.Status -ne 'Stopped') {
            throw "The service did not stop within $ServiceStopTimeoutSeconds seconds. Reboot the workstation and try again."
        }
    }

    # One host per interactive session, so on a multi-user machine this is a set, not a single
    # process. Wait on all of them by Id after signalling, so every image lock is gone before the
    # caller touches Program Files.
    $hostProcesses = @(Get-Process -Name $HostProcessName -ErrorAction SilentlyContinue)
    if ($hostProcesses.Count -gt 0) {
        Write-Step 'Stopping the user-session host...'
        $hostProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $hostProcesses.Id -Timeout $ServiceStopTimeoutSeconds -ErrorAction SilentlyContinue
    }
}

<#
.SYNOPSIS
    Deletes a directory tree, retrying while a just-terminated process still holds a file in it.
.DESCRIPTION
    A killed process releases its image asynchronously, so a delete immediately afterwards fails
    with "Access is denied". Retrying is what turns that race into a short wait, and matches how
    Copy-PayloadFile handles the same asynchrony on the write side.
#>
function Remove-DirectoryTree {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    for ($attempt = 1; $attempt -le $FileLockRetryCount; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force
            return
        }
        catch [System.UnauthorizedAccessException], [System.IO.IOException] {
            if ($attempt -eq $FileLockRetryCount) {
                throw "'$Path' is still in use after $FileLockRetryCount attempts. Reboot the workstation and try again."
            }
            Start-Sleep -Milliseconds $FileLockRetryMilliseconds
        }
    }
}

<#
.SYNOPSIS
    Copies one file, retrying while the previous process still holds it open.
.DESCRIPTION
    A stopped service releases its image asynchronously, and an upgrade that fails on a sharing
    violation leaves a half-copied Program Files directory - worse than either outcome it sits
    between. Retrying is what turns that into a wait.
#>
function Copy-PayloadFile {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    for ($attempt = 1; $attempt -le $FileLockRetryCount; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            return
        }
        catch [System.IO.IOException] {
            if ($attempt -eq $FileLockRetryCount) {
                throw "'$Destination' is still locked after $FileLockRetryCount attempts. Reboot the workstation and try again."
            }
            Start-Sleep -Milliseconds $FileLockRetryMilliseconds
        }
    }
}

function Copy-Payload {
    param([Parameter(Mandatory)][string]$PayloadDir)

    if (-not (Test-Path -LiteralPath $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $files = @(Get-PayloadFile -Directory $PayloadDir)
    Write-Step "Copying $($files.Count) files to $InstallDir..."

    foreach ($file in $files) {
        Copy-PayloadFile -Source $file.FullName -Destination (Join-Path $InstallDir $file.Name)
    }

    return ($files | Measure-Object -Property Length -Sum).Sum
}

<#
.SYNOPSIS
    Writes agent.config.json and lays out ProgramData, by asking the agent to do it.
.DESCRIPTION
    Delegated rather than reimplemented: the service is the one component that has to be able to
    read this layout back, so it owns the definition. A copy here would be free to drift from it,
    and an earlier version of this script proved the point by resolving ACL identities by name
    ("BUILTIN\Users"), which threw on a non-English Windows.
#>
function Set-AgentConfiguration {
    param([Parameter(Mandatory)][psobject]$Settings)

    Write-Step 'Writing the agent configuration...'

    $serviceExe = Join-Path $InstallDir $ServiceExeName
    $arguments = @('--configure', '--server-url', $Settings.ServerUrl, '--enrollment-token', $Settings.EnrollmentToken)
    if ($Settings.AllowInsecureHttp) { $arguments += '--allow-insecure-http' }

    & $serviceExe @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "The agent rejected its configuration (exit code $LASTEXITCODE). Nothing was started."
    }
}

function Register-AgentService {
    $binaryPath = Join-Path $InstallDir $ServiceExeName

    if (Get-AgentService) {
        Write-Step 'Service is already registered; the existing registration is kept.'
        return
    }

    Write-Step 'Registering the Windows service...'
    New-Service -Name $ServiceName `
                -BinaryPathName "`"$binaryPath`"" `
                -DisplayName $DisplayName `
                -Description $ServiceDescription `
                -StartupType Automatic | Out-Null

    # New-Service cannot express recovery actions, so this stays as sc.exe.
    & sc.exe failure $ServiceName reset= $FailureResetSeconds actions= $FailureActions | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'Could not set the service recovery actions. The agent will not restart itself after a crash.'
    }
}

<#
.SYNOPSIS
    Publishes the Add/Remove Programs entry.
.DESCRIPTION
    Spec section 3 requires the agent to be discoverable and never disguised: an employee must be
    able to see it listed like any other installed program. The uninstall command points at the
    copy of install.bat placed beside the binaries, because Windows runs an UninstallString
    without elevating it and the batch file is the part that knows how to elevate.
#>
function Register-UninstallEntry {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][long]$InstalledBytes
    )

    $batPath = Join-Path $InstallDir $InstallerBatName
    $estimatedKilobytes = [int][math]::Ceiling($InstalledBytes / $BytesPerKilobyte)

    if (-not (Test-Path -LiteralPath $UninstallKey)) {
        New-Item -Path $UninstallKey -Force | Out-Null
    }

    $values = @{
        DisplayName     = $DisplayName
        DisplayVersion  = $Version
        Publisher       = $Publisher
        DisplayIcon     = (Join-Path $InstallDir $ServiceExeName)
        InstallLocation = $InstallDir
        UninstallString = "`"$batPath`" uninstall"
        NoModify        = 1
        NoRepair        = 1
        EstimatedSize   = $estimatedKilobytes
    }

    foreach ($name in $values.Keys) {
        $type = if ($values[$name] -is [int]) { 'DWord' } else { 'String' }
        New-ItemProperty -Path $UninstallKey -Name $name -Value $values[$name] -PropertyType $type -Force | Out-Null
    }
}

function Unregister-UninstallEntry {
    if (Test-Path -LiteralPath $UninstallKey) {
        Remove-Item -Path $UninstallKey -Recurse -Force
    }
}

<#
.SYNOPSIS
    Copies the installer itself next to the binaries so the machine can uninstall on its own.
#>
function Copy-Installer {
    param([Parameter(Mandatory)][string]$PayloadDir)

    foreach ($name in @($InstallerBatName, $InstallerPs1Name)) {
        $source = Join-Path $PayloadDir $name
        if (Test-Path -LiteralPath $source) {
            Copy-PayloadFile -Source $source -Destination (Join-Path $InstallDir $name)
        }
    }
}

function Invoke-Install {
    $payloadDir = Resolve-PayloadDirectory
    $settings = Read-InstallSettings

    Write-Host ''
    Write-Step "Installing $DisplayName from $payloadDir"

    $version = Get-PayloadVersion -ServiceExePath (Join-Path $payloadDir $ServiceExeName)

    Stop-AgentProcess
    $installedBytes = Copy-Payload -PayloadDir $payloadDir
    Copy-Installer -PayloadDir $payloadDir

    Set-AgentConfiguration -Settings $settings
    Register-AgentService
    Register-UninstallEntry -Version $version -InstalledBytes $installedBytes

    Write-Step 'Starting the service...'
    Start-Service -Name $ServiceName

    Write-Host ''
    Write-Ok "$DisplayName $version is installed and running."
    Write-Ok "Server: $($settings.ServerUrl)"
    if ($settings.AllowInsecureHttp) {
        Write-Warn 'Insecure HTTP was permitted. Use this configuration for a test server only.'
    }
    Write-Ok 'The agent enrolls with the server shortly and begins collecting at the next logon.'
}

function Invoke-Uninstall {
    Write-Host ''

    $service = Get-AgentService
    if ($service) {
        Stop-AgentProcess
        Write-Step 'Removing the service...'
        & sc.exe delete $ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not remove the service (sc.exe exit code $LASTEXITCODE)."
        }
    }
    else {
        Write-Warn 'The service is not installed.'
        Stop-AgentProcess
    }

    if (Test-Path -LiteralPath $InstallDir) {
        Write-Step "Deleting $InstallDir..."
        Remove-DirectoryTree -Path $InstallDir
    }

    Unregister-UninstallEntry

    if ($PurgeData) {
        if (Test-Path -LiteralPath $DataDir) {
            Write-Step "Deleting $DataDir..."
            Remove-DirectoryTree -Path $DataDir
        }
        Write-Ok 'Collected data and stored credentials deleted.'
    }
    else {
        Write-Warn "Collected data left in $DataDir. Choose the purge option to remove it."
    }

    Write-Host ''
    Write-Ok 'Uninstall complete.'
}

<#
.SYNOPSIS
    Replaces the installation in place, keeping whatever the agent has already collected.
.DESCRIPTION
    Deliberately not "Uninstall then Install": the settings are read first, so an operator is not
    left with a machine that has no agent because they mistyped a token afterwards.
#>
function Invoke-Reinstall {
    $payloadDir = Resolve-PayloadDirectory
    $settings = Read-InstallSettings

    Write-Host ''
    Write-Step 'Reinstalling; collected data and the local queue are preserved.'

    $version = Get-PayloadVersion -ServiceExePath (Join-Path $payloadDir $ServiceExeName)

    Stop-AgentProcess

    if (Get-AgentService) {
        Write-Step 'Removing the existing service registration...'
        & sc.exe delete $ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not remove the existing service (sc.exe exit code $LASTEXITCODE)."
        }

        # sc.exe delete returns before the SCM has released the name; registering again too soon
        # fails with "marked for deletion".
        $deadline = (Get-Date).AddSeconds($ServiceStopTimeoutSeconds)
        while ((Get-AgentService) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds $ServiceStopPollMilliseconds
        }
        if (Get-AgentService) {
            throw 'The old service registration is still present. Reboot the workstation and try again.'
        }
    }

    if (Test-Path -LiteralPath $InstallDir) {
        Remove-DirectoryTree -Path $InstallDir
    }

    $installedBytes = Copy-Payload -PayloadDir $payloadDir
    Copy-Installer -PayloadDir $payloadDir

    Set-AgentConfiguration -Settings $settings
    Register-AgentService
    Register-UninstallEntry -Version $version -InstalledBytes $installedBytes

    Write-Step 'Starting the service...'
    Start-Service -Name $ServiceName

    Write-Host ''
    Write-Ok "$DisplayName $version reinstalled and running."
}

function Invoke-Status {
    Write-Host ''
    Write-Host "  $DisplayName" -ForegroundColor White
    Write-Host '  ----------------------------------------------------------------' -ForegroundColor DarkGray

    $service = Get-AgentService
    if ($service) {
        Write-Host "  Service  : $($service.Status)" -ForegroundColor Cyan
    }
    else {
        Write-Host '  Service  : not installed' -ForegroundColor Yellow
    }

    $serviceExe = Join-Path $InstallDir $ServiceExeName
    if (Test-Path -LiteralPath $serviceExe) {
        Write-Host "  Version  : $((Get-Item -LiteralPath $serviceExe).VersionInfo.ProductVersion)" -ForegroundColor Cyan
    }

    # Not $host - that is a reserved PowerShell automatic variable and assigning to it throws.
    $hostProcess = Get-Process -Name $HostProcessName -ErrorAction SilentlyContinue
    $hostState = if ($hostProcess) { "running (pid $($hostProcess.Id))" } else { 'not running' }
    Write-Host "  Host     : $hostState" -ForegroundColor Cyan

    $configPath = Join-Path $DataDir $ConfigFileName
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        Write-Host "  Server   : $($config.serverUrl)" -ForegroundColor Cyan
        if ($config.allowInsecureHttp) {
            Write-Warn 'Insecure HTTP is permitted on this workstation.'
        }
    }
    else {
        Write-Host '  Server   : not configured' -ForegroundColor Yellow
    }

    $databasePath = Join-Path $DataDir $DatabaseFileName
    if (Test-Path -LiteralPath $databasePath) {
        $sizeKb = [math]::Round((Get-Item -LiteralPath $databasePath).Length / $BytesPerKilobyte, 1)
        Write-Host "  Local DB : $databasePath ($sizeKb KB)" -ForegroundColor Cyan
    }

    $spoolCount = 0
    if (Test-Path -LiteralPath $ScreenshotDir) {
        $spoolCount = @(Get-ChildItem -LiteralPath $ScreenshotDir -File -ErrorAction SilentlyContinue).Count
    }
    Write-Host "  Spooled  : $spoolCount screenshots awaiting upload" -ForegroundColor Cyan

    $enrolled = Test-Path -LiteralPath (Join-Path $DataDir $CredentialFileName)
    Write-Host "  Enrolled : $(if ($enrolled) { 'yes' } else { 'no' })" -ForegroundColor Cyan
    Write-Host "  Logs     : $LogDir" -ForegroundColor Cyan
    Write-Host ''
}

# --- Entry point ------------------------------------------------------------------------------
if (-not (Test-Elevated)) {
    Write-Failure 'This installer must run as an administrator. Start it through install.bat.'
    exit $ExitNotElevated
}

# Uninstall triggered from Add/Remove Programs runs this script out of the very directory it is
# about to delete, and with that directory as the working directory. Relaunching from a temporary
# copy first is what lets the removal complete. Reinstall is not covered here on purpose: it needs
# a payload, and a payload can never be the install directory.
if ($Action -eq 'Uninstall' -and $PSScriptRoot -and
    $PSScriptRoot.TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) {

    $stagingDir = Join-Path ([IO.Path]::GetTempPath()) "EmployeeMonitorSetup-$([Guid]::NewGuid())"
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $stagingDir $InstallerPs1Name) -Force

    $relaunchArguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $stagingDir $InstallerPs1Name),
        '-Action', $Action
    )
    if ($PurgeData) { $relaunchArguments += '-PurgeData' }

    try {
        $process = Start-Process -FilePath (Get-Process -Id $PID).Path `
                                 -ArgumentList $relaunchArguments `
                                 -WorkingDirectory ([IO.Path]::GetTempPath()) `
                                 -Wait -PassThru -NoNewWindow
        $relaunchExitCode = $process.ExitCode
    }
    finally {
        # The child has exited by now, so its own copy is free to delete. Left behind it would
        # accumulate one stale installer per uninstall.
        Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    exit $relaunchExitCode
}

try {
    switch ($Action) {
        'Install'   { Invoke-Install }
        'Reinstall' { Invoke-Reinstall }
        'Uninstall' { Invoke-Uninstall }
        'Status'    { Invoke-Status }
    }

    exit $ExitSuccess
}
catch {
    Write-Host ''
    Write-Failure "$Action failed: $($_.Exception.Message)"

    # Every failure here is one an administrator has to act on, and the console is usually the only
    # record of it, so the classification decides which of them get a stack trace worth reading.
    if ($_.Exception -is [System.IO.FileNotFoundException] -or
        $_.Exception -is [System.IO.DirectoryNotFoundException]) {
        exit $ExitMissingPayload
    }
    if ($_.Exception -is [System.ArgumentException]) {
        exit $ExitInvalidArgument
    }

    Write-Host ''
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit $ExitFailed
}
