<#
.SYNOPSIS
    Builds the Employee Monitor agent and the package that installs it on a workstation.

.DESCRIPTION
    The build-machine half of the deployment story (spec section 11). It needs the .NET SDK, so
    it runs where the source is - never on a workstation.

    The machine-side half is scripts\payload\Install-Agent.ps1, which needs nothing but Windows.
    This script's Install, Uninstall and Status actions call that script rather than reimplementing
    it, so a developer machine and a workstation follow one code path.

.PARAMETER Action
    Publish   - build both executables self-contained into .\artifacts\agent
    Bundle    - publish, then assemble the redistributable folder in .\artifacts\deploy
    Package   - publish, then build the MSI into .\artifacts\installer
    Install   - publish, then install on this machine from the freshly published output
    Uninstall - stop and remove the service, and optionally delete collected data
    Status    - show the service state and what the agent has queued locally

    Bundle is the artifact for a fleet rollout: a folder that is copied to a workstation and
    installed by double-clicking install.bat, with no build step and no .NET prerequisite on the
    target. Install is the scripted path for development on this machine.

.PARAMETER ServerUrl
    Base URL of the monitoring server, e.g. https://monitoring.example.com
    Required for Install.

.PARAMETER EnrollmentToken
    Org enrollment token from the dashboard (Settings -> Organization). Required for Install.
    Traded once for a per-device API key; it is not itself a telemetry credential.

.PARAMETER AllowInsecureHttp
    Permit a plain-HTTP ServerUrl. For a local test server only - spec section 9 requires TLS.

.PARAMETER PurgeData
    With Uninstall, also delete the local database, screenshot spool and stored credential.

.PARAMETER CleanInstall
    With Install, delete existing ProgramData before installing. Without this switch, existing
    data is preserved and the operation behaves as an install over the previous installation.

.PARAMETER Compress
    With Bundle, also produce a .zip of the bundle folder for copying to workstations.

.EXAMPLE
    # Produce the folder that gets copied to all 30 workstations
    .\Deploy-Agent.ps1 -Action Bundle -Compress

.EXAMPLE
    .\Deploy-Agent.ps1 -Action Install -ServerUrl https://monitoring.example.com -EnrollmentToken abc123...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Publish', 'Bundle', 'Package', 'Install', 'Uninstall', 'Status')]
    [string]$Action,

    [string]$ServerUrl,
    [string]$EnrollmentToken,
    [switch]$AllowInsecureHttp,
    [switch]$PurgeData,
    [switch]$CleanInstall,
    [switch]$Compress
)

$ErrorActionPreference = 'Stop'

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$ArtifactDir  = Join-Path $RepoRoot 'artifacts\agent'
$InstallerDir = Join-Path $RepoRoot 'artifacts\installer'
$DeployRoot   = Join-Path $RepoRoot 'artifacts\deploy'
$PayloadDir   = Join-Path $PSScriptRoot 'payload'

$InstallerProject = Join-Path $RepoRoot 'installer\EmployeeMonitor.Installer.wixproj'
$ServiceProject   = Join-Path $RepoRoot 'src\Agent.Service\Agent.Service.csproj'
$HostProject      = Join-Path $RepoRoot 'src\Agent.Host\Agent.Host.csproj'

$ServiceExeName = 'EmployeeMonitor.Service.exe'
$HostExeName    = 'EmployeeMonitor.Host.exe'
$BundleNamePrefix = 'EmployeeMonitorAgent'

# The installer script is the single implementation of "install on a machine"; this script only
# decides which copy of it to run.
$MachineInstaller = Join-Path $PayloadDir 'Install-Agent.ps1'

# Build output and developer-only settings, which must never reach a workstation.
$ExcludedPayloadPatterns = @('*.pdb', 'appsettings.Development.json')

$BytesPerMegabyte = 1MB

function Invoke-Publish {
    Write-Host 'Publishing agent (self-contained, win-x64)...' -ForegroundColor Cyan

    # Both executables publish into the same folder on purpose: HostSupervisorWorker resolves
    # EmployeeMonitor.Host.exe relative to the service's own directory.
    dotnet publish $ServiceProject -c Release -o $ArtifactDir --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Service publish failed.' }

    dotnet publish $HostProject -c Release -o $ArtifactDir --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Host publish failed.' }

    Write-Host "Published to $ArtifactDir" -ForegroundColor Green
}

<#
.SYNOPSIS
    Assembles the redistributable folder: the runtime files plus the installer that drives them.
.DESCRIPTION
    Everything a workstation needs and nothing it does not. The published output is already
    self-contained and single-file, so this is a copy and a filter rather than a second build -
    which is the point: the machine that runs install.bat has no SDK, no runtime and, often, no
    network access to get either.
#>
function Invoke-Bundle {
    Invoke-Publish

    $version = (Get-Item -LiteralPath (Join-Path $ArtifactDir $ServiceExeName)).VersionInfo.ProductVersion
    $version = ($version -split '\+')[0].Trim()
    if ([string]::IsNullOrWhiteSpace($version)) { throw 'The published service carries no product version.' }

    $bundleName = "$BundleNamePrefix-$version"
    $bundleDir  = Join-Path $DeployRoot $bundleName

    Write-Host "Assembling the deployment bundle for $version..." -ForegroundColor Cyan

    # Rebuilt from scratch each time: a stale executable left behind by a previous version is
    # exactly the file that would get shipped and never noticed.
    if (Test-Path -LiteralPath $bundleDir) { Remove-Item -LiteralPath $bundleDir -Recurse -Force }
    New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null

    $runtimeFiles = Get-ChildItem -LiteralPath $ArtifactDir -File | Where-Object {
        $name = $_.Name
        -not ($ExcludedPayloadPatterns | Where-Object { $name -like $_ })
    }

    foreach ($file in $runtimeFiles) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $bundleDir $file.Name) -Force
    }

    foreach ($file in (Get-ChildItem -LiteralPath $PayloadDir -File)) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $bundleDir $file.Name) -Force
    }

    foreach ($required in @($ServiceExeName, $HostExeName, 'install.bat', 'Install-Agent.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bundleDir $required))) {
            throw "The bundle is missing '$required'. Check scripts\payload."
        }
    }

    $sizeMb = [math]::Round((Get-ChildItem -LiteralPath $bundleDir -File | Measure-Object -Property Length -Sum).Sum / $BytesPerMegabyte, 1)
    Write-Host "Bundle: $bundleDir ($sizeMb MB)" -ForegroundColor Green

    if ($Compress) {
        $zipPath = Join-Path $DeployRoot "$bundleName.zip"
        Write-Host 'Compressing (this takes a while - the runtime is bundled in)...' -ForegroundColor Cyan
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
        Compress-Archive -Path (Join-Path $bundleDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
        $zipMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / $BytesPerMegabyte, 1)
        Write-Host "Archive: $zipPath ($zipMb MB)" -ForegroundColor Green
    }

    Write-Host ''
    Write-Host 'Copy the bundle folder to a workstation and run install.bat as administrator.' -ForegroundColor Gray
    Write-Host 'No .NET runtime or SDK is required on the target machine.' -ForegroundColor Gray
}

function Invoke-Package {
    Invoke-Publish

    Write-Host 'Building the MSI...' -ForegroundColor Cyan

    # The WiX project packages an already-published directory rather than building the agent
    # itself: the publish settings (self-contained, untrimmed - trimming silently breaks USB
    # collection) live with the code that depends on them.
    dotnet build $InstallerProject -c Release --nologo `
        -p:AgentPublishDir=$ArtifactDir `
        -p:OutputPath=$InstallerDir
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }

    $msi = Join-Path $InstallerDir 'EmployeeMonitorAgent.msi'
    Write-Host "Built $msi" -ForegroundColor Green
    Write-Host 'Install it with:' -ForegroundColor Green
    Write-Host "  msiexec /i `"$msi`" /qn SERVERURL=https://monitoring.example.com ENROLLMENTTOKEN=<token>" -ForegroundColor Gray
}

<#
.SYNOPSIS
    Runs the machine-side installer against a directory of published binaries.
#>
function Invoke-MachineInstaller {
    param([Parameter(Mandatory)][string[]]$Arguments)

    if (-not (Test-Path -LiteralPath $MachineInstaller)) {
        throw "The machine installer is missing from $PayloadDir."
    }

    & $MachineInstaller @Arguments
    if ($LASTEXITCODE -ne 0) { throw "The installer exited with code $LASTEXITCODE." }
}

function Invoke-Install {
    Invoke-Publish

    $arguments = @('-Action', 'Install', '-SourceDir', $ArtifactDir)
    if ($ServerUrl)         { $arguments += @('-ServerUrl', $ServerUrl) }
    if ($EnrollmentToken)   { $arguments += @('-EnrollmentToken', $EnrollmentToken) }
    if ($AllowInsecureHttp) { $arguments += '-AllowInsecureHttp' }
    if ($CleanInstall)      { $arguments += '-CleanInstall' }

    Invoke-MachineInstaller -Arguments $arguments
}

function Invoke-Uninstall {
    $arguments = @('-Action', 'Uninstall')
    if ($PurgeData) { $arguments += '-PurgeData' }

    Invoke-MachineInstaller -Arguments $arguments
}

switch ($Action) {
    'Publish'   { Invoke-Publish }
    'Bundle'    { Invoke-Bundle }
    'Package'   { Invoke-Package }
    'Install'   { Invoke-Install }
    'Uninstall' { Invoke-Uninstall }
    'Status'    { Invoke-MachineInstaller -Arguments @('-Action', 'Status') }
}
