#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"

$Branch    = if ($env:MT_NODE_BRANCH)       { $env:MT_NODE_BRANCH }       else { "main" }
$InstallDir = if ($env:MT_NODE_INSTALL_DIR) { $env:MT_NODE_INSTALL_DIR }  else { Join-Path $HOME ".machine-tube\mt-node" }
$BinDir    = if ($env:MT_NODE_BIN_DIR)      { $env:MT_NODE_BIN_DIR }      else { Join-Path $HOME ".local\bin" }
$InboxDir  = if ($env:MT_NODE_INBOX_DIR)    { $env:MT_NODE_INBOX_DIR }    else { Join-Path $HOME "MachineTube\videos" }
$Mode      = if ($env:MT_NODE_MODE)         { $env:MT_NODE_MODE }         else { "local" }
$WrapperPath = Join-Path $BinDir "mt-node.cmd"
$ConfigEnvPath = Join-Path $InstallDir "config.env"

function Need-Cmd($cmd) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "mt-node install error: missing required command '$cmd'"
        exit 1
    }
}

Need-Cmd node
Need-Cmd npm

if ($Mode -eq "docker") {
    Need-Cmd docker
}

New-Item -ItemType Directory -Force -Path $BinDir    | Out-Null
New-Item -ItemType Directory -Force -Path $InboxDir  | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null

function Preserve-RuntimeState {
    param(
        [string]$InstallDir,
        [string]$ConfigEnvPath,
        [string]$PreserveDir
    )

    if (Test-Path $ConfigEnvPath) {
        Move-Item $ConfigEnvPath (Join-Path $PreserveDir "config.env")
    }

    $DataDir = Join-Path $InstallDir "data"
    if (Test-Path $DataDir) {
        Move-Item $DataDir (Join-Path $PreserveDir "data")
    }
}

function Restore-RuntimeState {
    param(
        [string]$InstallDir,
        [string]$ConfigEnvPath,
        [string]$PreserveDir
    )

    $PreservedConfig = Join-Path $PreserveDir "config.env"
    if (Test-Path $PreservedConfig) {
        Move-Item $PreservedConfig $ConfigEnvPath
    }

    $PreservedData = Join-Path $PreserveDir "data"
    if (Test-Path $PreservedData) {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $InstallDir "data")
        Move-Item $PreservedData (Join-Path $InstallDir "data")
    }
}

$TmpDir = Join-Path $env:TEMP "mt-node-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
try {
    $ArchivePath = Join-Path $TmpDir "mt-node.zip"
    $ExtractDir  = Join-Path $TmpDir "extract"
    Write-Host "Downloading mt-node source archive"
    Invoke-WebRequest -Uri "https://github.com/enigmind-ai/machine-tube-node/archive/refs/heads/$Branch.zip" -OutFile $ArchivePath
    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $PreserveDir = Join-Path $TmpDir "preserve"
    New-Item -ItemType Directory -Force -Path $PreserveDir | Out-Null

    # Move away from $InstallDir before removing it. Windows holds a handle on
    # the shell's CWD, which causes Remove-Item to fail if the terminal is
    # sitting inside the install directory. Use $HOME rather than $TmpDir so
    # the finally-block cleanup of $TmpDir doesn't hit the same problem.
    Set-Location $HOME

    if (Test-Path $InstallDir) {
        Write-Host "Replacing mt-node install in $InstallDir"
        Preserve-RuntimeState -InstallDir $InstallDir -ConfigEnvPath $ConfigEnvPath -PreserveDir $PreserveDir
        Remove-Item -Recurse -Force $InstallDir

        # Windows can take a moment to fully release directory handles after removal.
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ((Test-Path $InstallDir) -and ([DateTime]::UtcNow -lt $deadline)) {
            Start-Sleep -Milliseconds 200
        }
        if (Test-Path $InstallDir) {
            Write-Error "Could not remove '$InstallDir'. Make sure mt-node is not running and your terminal's working directory is not inside that folder, then try again."
            exit 1
        }
    } else {
        Write-Host "Installing mt-node into $InstallDir"
    }

    Move-Item (Join-Path $ExtractDir "machine-tube-node-$Branch") $InstallDir
    Restore-RuntimeState -InstallDir $InstallDir -ConfigEnvPath $ConfigEnvPath -PreserveDir $PreserveDir
} finally {
    Remove-Item -Recurse -Force $TmpDir
}

Set-Location $InstallDir

Write-Host "Installing npm dependencies"
if (Test-Path (Join-Path $InstallDir "package-lock.json")) {
    npm ci --include=dev
} else {
    npm install --include=dev
}

Write-Host "Building mt-node"
npm run build

Write-Host "Creating default mt-node config file"
node "$InstallDir\dist\index.js" config init

Write-Host "Preparing managed media tools"
node "$InstallDir\scripts\bootstrap-media-tools.mjs"

# Create a .cmd wrapper so `mt-node` works from any terminal
@"
@echo off
node "$InstallDir\dist\index.js" %*
"@ | Set-Content -Encoding ASCII $WrapperPath

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "data") | Out-Null

# Add BinDir to the user's PATH if not already present
$UserPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$BinDir*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$UserPath;$BinDir", "User")
    Write-Host "Added $BinDir to your PATH (restart your terminal to take effect)"
}

if ($Mode -eq "docker") {
    Write-Host "Launching mt-node in Docker mode"
    node "$InstallDir\scripts\run-mt-node-docker.mjs"
    Write-Host @"

mt-node installed successfully.

Install directory: $InstallDir
Launcher:         $WrapperPath
Config file:      $ConfigEnvPath
MachineTube inbox: $InboxDir
Mode: docker
Peer delivery default: assist

mt-node was launched as its own Docker container.
Drop videos into the inbox folder and point OpenClaw at:
  http://localhost:43110

To enable restart-restored seeding, edit:
  $ConfigEnvPath
and set:
  MT_NODE_PEER_DELIVERY_MODE=permanent

For built-in thumbnail and HLS output, mt-node can manage FFmpeg itself. See:
  $InstallDir\README.md
"@
} else {
    Write-Host @"

mt-node installed successfully.

Install directory: $InstallDir
Launcher:         $WrapperPath
Config file:      $ConfigEnvPath
MachineTube inbox: $InboxDir
Mode: local
Peer delivery default: assist

Drop videos into the inbox folder, then start mt-node and publish the latest or a named inbox file.

To enable restart-restored seeding, edit:
  $ConfigEnvPath
and set:
  MT_NODE_PEER_DELIVERY_MODE=permanent

For built-in thumbnail and HLS output, mt-node can manage FFmpeg itself. See:
  $InstallDir\README.md

Restart your terminal, then run:
  mt-node
"@
}
