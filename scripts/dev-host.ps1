#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
  dev:host — Windows native CP/Agent/Runtime/UI + Docker PostgreSQL/Sandbox

.DESCRIPTION
  Stack-aware (PLAN-0533): reads XIHE_STACK_ID (default stack-1) through
  scripts/stack-run.mjs → workspace SSOT deriveStack(). Ports, compose project,
  sandbox container prefix and data/log/state dirs all come from that single
  derivation. stack-1 keeps today's ports and paths unchanged.

.PARAMETER Check  Preflight only
.PARAMETER Start  Bring up postgres + native services (delegates to mise run dev:host)
.PARAMETER Watch  Start + health loop with auto-restart (delegates to mise run dev:host:watch)
.PARAMETER Stop   Tear down this stack's postgres + native services + sandbox containers
#>
param(
  [switch]$Check,
  [switch]$Start,
  [switch]$Watch,
  [switch]$Stop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path "$PSScriptRoot/..").Path

# Single source of derived values: <one>/scripts/ports.mjs via stack-run.mjs.
# Fail-fast on unregistered XIHE_STACK_ID (spec I4) happens inside stack-run.
$StackJson = & node "$PSScriptRoot/stack-run.mjs" env-json
if ($LASTEXITCODE -ne 0 -or -not $StackJson) {
  Write-Host "dev:host: cannot resolve XIHE_STACK_ID (see error above)" -ForegroundColor Red
  exit 2
}
$Stack = $StackJson | ConvertFrom-Json
$StackId = $Stack.stackId
$ComposeProject = $Stack.composeProject
$Database = $Stack.database
$Prefix = $Stack.containerPrefix
$NativePorts = @([int]$Stack.ports.ui, [int]$Stack.ports.cp, [int]$Stack.ports.agent, [int]$Stack.ports.runtime)
$AllPorts = @($NativePorts + @([int]$Stack.ports.postgres))

$HostRootSource = if ($env:XIHE_WORKSPACE_HOST_ROOT) { $env:XIHE_WORKSPACE_HOST_ROOT } else { $Stack.hostRoot }
$HostRoot = if ([System.IO.Path]::IsPathRooted($HostRootSource)) { [System.IO.Path]::GetFullPath($HostRootSource) } else { Join-Path $ProjectRoot $HostRootSource }
$LogDir = if ($env:XIHE_LOG_DIR) { (Resolve-Path $env:XIHE_LOG_DIR -ErrorAction SilentlyContinue).Path } else { Join-Path $ProjectRoot $Stack.logDir }
if (-not $LogDir) { $LogDir = Join-Path $ProjectRoot $Stack.logDir }
$PidDir = if ($StackId -eq "stack-1") { Join-Path $ProjectRoot ".tmp/dev-host" } else { Join-Path $ProjectRoot ".tmp/dev-host/$($Stack.index)" }
$DevHostLog = Join-Path $LogDir "host.log"
$DevHostRunId = [guid]::NewGuid().ToString()
$Timestamp = { param($e) Get-Date -Format o }

function Write-DevHostEvent {
  param([string]$Event, [hashtable]$Fields = @{})
  $payload = @{ timestamp = (& $Timestamp $null); devHostRunId = $DevHostRunId; stackId = $StackId; event = $Event } + $Fields
  $json = $payload | ConvertTo-Json -Compress
  Add-Content -Path $DevHostLog -Value $json -Encoding utf8
}

function Test-PortFree {
  param([int]$Port)
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

# Docker Desktop proxies published ports through a path that Get-NetTCPConnection
# does not always see (observed on 12634), so a bind probe alone under-reports.
function Test-PortReachable {
  param([int]$Port)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync("127.0.0.1", $Port)
    if (-not $task.Wait(300)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Dispose() }
}

function Test-PortInUse {
  param([int]$Port)
  return (-not (Test-PortFree -Port $Port)) -or (Test-PortReachable -Port $Port)
}

function Test-Tool {
  param([string]$Name, [string]$Cmd)
  try { $v = Invoke-Expression "$Cmd 2>&1 | Select-Object -First 1"; return "$Name ok: $v" }
  catch { return "$Name MISSING: $_" }
}

function Send-ToRecycleBin {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $Path,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}

# This stack's sandbox containers only: name prefix AND xihe.stack-id label
# (a missing label is legacy stack-1, B3).
function Get-StackContainers {
  $rows = @(docker ps -a --format '{{.ID}}|{{.Names}}|{{.Label "xihe.stack-id"}}')
  $matched = @()
  foreach ($row in $rows) {
    if (-not $row) { continue }
    $parts = $row.Split('|')
    if ($parts.Count -lt 3) { continue }
    $id = $parts[0].Trim()
    $name = $parts[1].Trim()
    $label = if ($parts[2].Trim()) { $parts[2].Trim() } else { "stack-1" }
    if ($name.StartsWith($Prefix) -and $label -eq $StackId) { $matched += $id }
  }
  return $matched
}

function Remove-WorkspaceContainers {
  $containers = @(Get-StackContainers)
  foreach ($id in $containers) {
    if ($id) {
      docker rm -f $id | Out-Null
      Write-DevHostEvent -Event "container_removed" -Fields @{ containerId = $id; scope = "workspace-sandbox" }
    }
  }
  if ($containers.Count -gt 0) {
    Write-Host "Removed $($containers.Count) workspace Sandbox container(s) of $StackId; host storage preserved." -ForegroundColor Green
  }
}

function Stop-NativeServices {
  $currentProcessId = $PID
  $owners = @(
    foreach ($port in $NativePorts) {
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess
    }
  ) | Sort-Object -Unique

  foreach ($owner in $owners) {
    if ($owner -and $owner -ne $currentProcessId) {
      try {
        Stop-Process -Id $owner -Force -ErrorAction Stop
        Write-DevHostEvent -Event "process_stopped" -Fields @{ pid = $owner; scope = "native-service-port" }
        Write-Host "Stopped native service process $owner" -ForegroundColor Yellow
      } catch {
        Write-DevHostEvent -Event "process_stop_failed" -Fields @{ pid = $owner; scope = "native-service-port"; detail = "$($_)" }
        Write-Host "Could not stop native service process $owner : $_" -ForegroundColor Yellow
      }
    }
  }
}

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
  New-Item -ItemType Directory -Force -Path $HostRoot | Out-Null
}

function Do-Check {
  Ensure-Dirs
  Write-Host "=== dev:host -Check (stack=$StackId runId=$DevHostRunId) ===" -ForegroundColor Cyan
  Write-Host "stack: $StackId base=$($Stack.base) compose=$ComposeProject db=$Database" -ForegroundColor DarkGray
  Write-Host "ports: ui=$($Stack.ports.ui) cp=$($Stack.ports.cp) agent=$($Stack.ports.agent) runtime=$($Stack.ports.runtime) pg=$($Stack.ports.postgres)" -ForegroundColor DarkGray
  Write-DevHostEvent -Event "devhost_run_started" -Fields @{ mode = "check"; hostRootRef = "XIHE_WORKSPACE_HOST_ROOT"; hostRoot = $HostRoot }

  $ok = $true
  # Docker
  try {
    $dv = docker version --format '{{.Server.Version}}' 2>&1
    Write-Host "Docker: $dv" -ForegroundColor Green
    Write-DevHostEvent -Event "process_ready" -Fields @{ service = "docker"; outcome = "ok"; detail = "$dv" }
  } catch {
    Write-Host "Docker NOT available: $_" -ForegroundColor Red; $ok = $false
    Write-DevHostEvent -Event "process_failed" -Fields @{ service = "docker"; errorCode = "DOCKER_UNAVAILABLE"; detail = "$_" }
  }
  $npipe = "\\.\pipe\docker_engine"
  if (Test-Path $npipe) { Write-Host "npipe: $npipe exists" -ForegroundColor Green } else { Write-Host "npipe: $npipe NOT found (Docker Desktop may be off)" -ForegroundColor Yellow }

  # Host root
  try {
    $testFile = Join-Path $HostRoot ".devhost-probe"
    Set-Content -Path $testFile -Value "probe" -Encoding utf8 -Force
    Send-ToRecycleBin -Path $testFile
    $free = (Get-PSDrive -Name ($HostRoot.Substring(0,1)) -ErrorAction SilentlyContinue)
    Write-Host "hostRoot: $HostRoot writable (drive free ~$([math]::Round($free.Free/1GB,1))GB)" -ForegroundColor Green
    Write-DevHostEvent -Event "process_ready" -Fields @{ service = "host_root"; hostRootRef = "XIHE_WORKSPACE_HOST_ROOT"; outcome = "ok" }
  } catch {
    Write-Host "hostRoot NOT writable: $HostRoot : $_" -ForegroundColor Red; $ok = $false
    Write-DevHostEvent -Event "process_failed" -Fields @{ service = "host_root"; errorCode = "STORAGE_UNAVAILABLE"; detail = "$_" }
  }

  # Ports (bind probe + TCP reachability: see Test-PortReachable note)
  foreach ($p in $AllPorts) {
    if (-not (Test-PortInUse -Port $p)) { Write-Host "port $p free" -ForegroundColor Green }
    else { Write-Host "port $p IN USE" -ForegroundColor Yellow; $ok = $false; Write-DevHostEvent -Event "process_failed" -Fields @{ service = "port"; port = $p; errorCode = "PORT_IN_USE" } }
  }

  # Tools
  Write-Host (Test-Tool -Name "mise" -Cmd "mise --version")
  Write-Host (Test-Tool -Name "java" -Cmd "java --version")
  Write-Host (Test-Tool -Name "node" -Cmd "node --version")
  Write-Host (Test-Tool -Name "pnpm" -Cmd "pnpm --version")
  Write-Host (Test-Tool -Name "uv" -Cmd "uv --version")
  Write-Host (Test-Tool -Name "cargo" -Cmd "cargo --version")
  Write-Host (Test-Tool -Name "docker compose" -Cmd "docker compose version")

  Write-DevHostEvent -Event "devhost_run_finished" -Fields @{ mode = "check"; outcome = $(if ($ok) { "ok" } else { "degraded" }) }
  if ($ok) { Write-Host "`nCheck OK — run `mise run dev:host` to bring up" -ForegroundColor Cyan }
  else { Write-Host "`nCheck finished with warnings — fix above before starting" -ForegroundColor Yellow }
}

function Do-Stop {
  Ensure-Dirs
  Write-Host "=== dev:host -Stop (stack=$StackId) ===" -ForegroundColor Cyan
  Write-DevHostEvent -Event "cleanup_started" -Fields @{ scope = "dev-host" }
  Push-Location $ProjectRoot
  try {
    Stop-NativeServices
    Write-Host "Stopping postgres (compose project $ComposeProject)..." -ForegroundColor Cyan
    $env:XIHE_COMPOSE_PROJECT = $ComposeProject
    docker compose -p $ComposeProject stop postgres 2>$null
    Remove-WorkspaceContainers
    # Do NOT down volumes or remove host directories
    Write-Host "Postgres stopped (volume kept, hostRoot kept: $HostRoot)" -ForegroundColor Green
  } finally { Pop-Location }

  # Kill any pid files if we ever background native services (v1: none, placeholder)
  if (Test-Path $PidDir) {
    Get-ChildItem $PidDir -Filter "*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $filePid = Get-Content $_.FullName -Raw | ForEach-Object { $_.Trim() }
        if ($filePid -match '^\d+$') {
          Write-Host "Killing pid $filePid from $($_.Name)" -ForegroundColor Yellow
          Stop-Process -Id $filePid -Force -ErrorAction SilentlyContinue
        }
        Send-ToRecycleBin -Path $_.FullName
      } catch {}
    }
  }
  Write-DevHostEvent -Event "cleanup_finished" -Fields @{ scope = "dev-host"; outcome = "ok" }
  Write-Host "dev:host stopped. Host directories preserved: $HostRoot" -ForegroundColor Green
}

if ($Check) { Do-Check; exit 0 }
if ($Stop)  { Do-Stop; exit 0 }
if ($Watch) { & mise run dev:host:watch; exit $LASTEXITCODE }
if ($Start) { & mise run dev:host; exit $LASTEXITCODE }

# default: check
Do-Check
