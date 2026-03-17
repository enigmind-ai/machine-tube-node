#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"

$RepoUrl   = "https://github.com/enigmind-ai/machine-tube-node.git"
$Branch    = if ($env:MT_NODE_BRANCH)       { $env:MT_NODE_BRANCH }       else { "main" }
$InstallDir = if ($env:MT_NODE_INSTALL_DIR) { $env:MT_NODE_INSTALL_DIR }  else { Join-Path $HOME ".machine-tube\mt-node" }
$BinDir    = if ($env:MT_NODE_BIN_DIR)      { $env:MT_NODE_BIN_DIR }      else { Join-Path $HOME ".local\bin" }
$InboxDir  = if ($env:MT_NODE_INBOX_DIR)    { $env:MT_NODE_INBOX_DIR }    else { Join-Path $HOME "MachineTube\videos" }
$Mode      = if ($env:MT_NODE_MODE)         { $env:MT_NODE_MODE }         else { "local" }
$WrapperPath = Join-Path $BinDir "mt-node.cmd"

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

if (Get-Command git -ErrorAction SilentlyContinue) {
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Host "Updating mt-node in $InstallDir"
        git -C $InstallDir fetch --depth 1 origin $Branch
        git -C $InstallDir checkout $Branch
        git -C $InstallDir reset --hard "origin/$Branch"
    } else {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir
        Write-Host "Cloning mt-node into $InstallDir"
        git clone --depth 1 --branch $Branch $RepoUrl $InstallDir
    }
} else {
    $TmpDir = Join-Path $env:TEMP "mt-node-install-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    $ArchivePath = Join-Path $TmpDir "mt-node.zip"
    $ExtractDir  = Join-Path $TmpDir "extract"
    Write-Host "Downloading mt-node source archive"
    Invoke-WebRequest -Uri "https://github.com/enigmind-ai/machine-tube-node/archive/refs/heads/$Branch.zip" -OutFile $ArchivePath
    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallDir
    Move-Item (Join-Path $ExtractDir "machine-tube-node-$Branch") $InstallDir
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
MachineTube inbox: $InboxDir
Mode: docker

mt-node was launched as its own Docker container.
Drop videos into the inbox folder and point OpenClaw at:
  http://localhost:43110
"@
} else {
    Write-Host @"

mt-node installed successfully.

Install directory: $InstallDir
Launcher:         $WrapperPath
MachineTube inbox: $InboxDir
Mode: local

Drop videos into the inbox folder, then start mt-node and publish the latest or a named inbox file.

Restart your terminal, then run:
  mt-node
"@
}
